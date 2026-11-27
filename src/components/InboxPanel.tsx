import { machineWords } from "../lib/platform";
import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { cardAreaOf, withAreaName } from "../lib/areaPicker";
import { areaOfTag } from "../lib/releaseSheet";
import { ensureAreasRead, useAreas } from "../store/areaStore";
import { useCardPresenter } from "../hooks/useCardLive";
import { useLiveReviewTips } from "./useReviewTip";
import { useInbox } from "../store/inboxStore";
import type { ReconciledEvent } from "../lib/inboxReconcile";
import { useWorkspaces } from "../store/workspaceStore";
import { openCardStep, openCenterMode, useUi } from "../store/uiStore";
import { SEE_THE_REVIEW_LABEL } from "../lib/reviewSection";
import { OPEN_SESSION, OPEN_THE_BUILDER, openWaitingSession } from "../store/openWaitingSession";
import { usePageVisible } from "../hooks/usePageVisible";
import { useNeedsYou, useNow } from "../hooks/useNeedsYou";
import { waitingWords, type WaitingSession } from "../lib/needsYou";
import { onKanbanChanged, openWebLink, type InboxEvent, type KanbanCard, type PendingBranchCleanup } from "../ipc";
import { useBranchCleanup } from "../store/branchCleanupStore";
import { pushToast } from "../store/toastStore";
import { askWords, backlogWords } from "../lib/branchCleanup";
import { DELETE_CARD_BRANCHES } from "../lib/shippingPage";
import { confirmChoice } from "../store/confirmStore";
import { useKanban } from "../store/kanbanStore";
import { useTeamAllowed } from "../store/accountStore";
import { isShipBatchEligible } from "../lib/boardSemantics";
import { prFixOffered, prMergeReady } from "../lib/prFix";
import { prCardReadyToMerge, upToDateRefusedLine } from "../lib/prStatus";
import { boardNextPress, cardSessionWords, readyToShipChecks, type CardPresentation } from "../lib/cardPresentation";
import { useBuilder } from "../store/builderStore";
import {
  BRING_UP_TO_DATE_ACTION,
  CLEAR_THE_NEWS,
  CLEAR_THE_NEWS_TITLE,
  FIX_ACTION,
  GO_TO_THE_BOARD,
  INBOX_EMPTY_SENTENCE,
  INBOX_EMPTY_TITLE,
  INBOX_GROUP_CAP,
  INBOX_GROUPS,
  MERGE_ACTION,
  PAUSED_ON_CLOSE_DETAIL,
  isFailureRow,
  isIdeasRow,
  needsYouOrder,
  isNewsRow,
  newsRowIds,
  onNewsShelf,
  pausedRowWords,
  inboxRowWords,
  inboxChipName,
  inboxSectionCount,
  inboxSummary,
  inboxWhen,
  prOfInboxId,
  prOpenedWords,
  reviewCardOf,
  shippedThisWeek,
  type InboxPageGroup,
  type InboxRowContext,
} from "../lib/inboxView";
import { ModeHeader } from "./ModeHeader";
import { CBtn, Callout, Group, Icon, MoreMenu, Page, PChip, Row, Section } from "./ux";
import { useReopenOffer } from "./ReopenSessionsOffer";
import { reopenList, reopenPointerWords } from "../lib/terminalConversations";
import { useDoctor } from "../store/doctorStore";
import { RecentMessagesSheet } from "./RecentMessagesSheet";
import { linkDidNotOpen } from "../lib/linkToast";
import { MERGE_STILL_RUNNING, pressOnce, prMergePressKey, sayStillRunning } from "../lib/pressOnce";
import { pushErrorToast } from "../lib/errorToast";
import { ReadAgainButton } from "./ReadAgainButton";
import { READ_IT_AGAIN } from "../lib/errorButtons";

/**
 * UX-4.2 (the Inbox board, ADR 0007): the Inbox is a page — the landing
 * page (UX-4.3). One centred column: a sentence that sums it up, then the
 * groups that have something — Needs you · Working · On hold · Scheduled ·
 * News (1.173.0 F1: a card's row says its Board card's state and press) —
 * each a subheading with its count over rows split by hairlines. A row is a
 * state dot, the workspace as a chip, the title over a detail of up to two lines, when,
 * and one action. Ships are not rows: one quiet line counts this week's and
 * opens History, which also holds the costs.
 *
 * Data is the flat global `useInbox` feed; seen rows keep their place and
 * read in `--muted`. UX-4.4: a Claude or Codex session waiting at its prompt
 * — a tile, or a card's Builder — is a Needs you row too, first, with Open
 * session; it goes when the session gets its answer (`lib/needsYou.ts`).
 */

/** PR-freshness fallback poll while the page is on screen. Event-driven
 *  refresh (kanban://changed, agent://run-done) covers everything else;
 *  the backend gh cache TTL (5 min) makes most ticks a cache hit. */
const PANEL_POLL_MS = 60_000;

/** A5 round 1 (owner): ⋯'s last item where the row's action doesn't open
 *  what the row is about — its card, or the Settings page it asks about. */
const OPEN_THE_CARD = "Open the card";
const OPEN_SETTINGS = "Open Settings";

/** One row of the page, whatever it came from. */
export type InboxItem = {
  id: string;
  dot: "running" | "done" | "aborted" | "empty" | "accent";
  workspaceName: string;
  title: string;
  detail: string | null;
  at: number | null;
  /** QoL 14.2 (F7): `at` is when a pull request was opened ("opened 3h ago"). */
  opened?: boolean;
  /** The one action; null draws the chevron that opens the row. 1.174.0
   *  (A5, P16): never filled — every row's action is bordered, as on the
   *  Board; the order says where to start. */
  action: string | null;
  /** The action's words while it runs (Merge → "Merging…"). */
  busyAction?: string;
  /** A5: the action merges (or brings this computer up to date) or ships
   *  — the order of Needs you. */
  press?: "merge" | "ship";
  /** A5 round 1 (owner): the action does something other than open the
   *  row's card or page, so ⋯ ends with this way in ("Open the card"). */
  openLabel?: string;
  /** CL-3: the detail names a serious catch (a P1): said in weight only. */
  serious?: boolean;
  /** What the action does when it is not opening the row (Ship it). */
  act?: () => void;
  /** N18: the row's other answers, in its ⋯ after the one action (Keep
   *  them; Not now · Never). A0: one action per row, the rest in ⋯. */
  more?: { label: string; act: () => void }[];
  /** An answer is on its way: the row's buttons wait. */
  busy?: boolean;
  /** P-A: the row's card rule, as `data-ply-rule`. */
  rule?: string;
  /** F1: the row says something failed — first in Needs you. */
  failure?: boolean;
  /** F1 (BI-7): an On hold row of one paused card, grouped per workspace. */
  paused?: { workspaceId: string; title: string };
  /** F1 (BI-7): how many cards a grouped row stands for. */
  cards?: number;
  seen: boolean;
  open: () => void;
};

const DOT_CLASS: Record<InboxItem["dot"], string> = {
  running: "ux-state-dot ux-state-dot--running ux-state-dot--live",
  done: "ux-state-dot ux-state-dot--done",
  aborted: "ux-state-dot ux-state-dot--aborted",
  empty: "ux-state-dot",
  // A5: an unseen round of ideas; gray once seen.
  accent: "ux-state-dot ux-state-dot--accent",
};

/** UX P-A Mac walk 5: a loaded card's row has its card's dot — the one the
 *  Board card, the List, Now and the sidebar draw. */
function cardDot(p: CardPresentation): InboxItem["dot"] {
  return p.dot.state;
}

function dotOf(ev: InboxEvent): InboxItem["dot"] {
  if (isIdeasRow(ev)) return ev.seenAt == null ? "accent" : "empty";
  if (ev.group === "running") return "running";
  // F1: a failure keeps its amber in Needs you.
  if (ev.group === "needs_you") return isFailureRow(ev) ? "aborted" : "done";
  return "empty";
}

function waitingItem(s: WaitingSession, workspaceName: string): InboxItem {
  const words = waitingWords(s);
  return {
    id: s.id,
    // P3 walk: a tile asking (trust, a limit, bypass) has the amber a card
    // asking has; a tile merely at its prompt keeps the plain dot.
    dot: s.target.kind === "tile" && s.question ? "aborted" : "empty",
    workspaceName,
    title: words.title,
    detail: words.detail,
    at: s.since,
    // 1.172.0 D2: a card's press has the card's names — Open the Builder
    // (or, while it plans, Open the conversation); a tile's is Open session.
    action:
      s.question === "intake-stopped"
        ? "Open card"
        : s.question === "plan"
          ? "Open the plan"
          : s.target.kind === "card"
            ? s.intake
              ? "Open the conversation"
              : OPEN_THE_BUILDER
            : OPEN_SESSION,
    // QoL 1.168 (D7): a usage limit reads grey and is not counted
    // (`attentionCounts`).
    seen: s.muted != null,
    open: () => openWaitingSession(s),
  };
}

/** N18: the card-branch cleanup's questions for one workspace — the archived
 *  cards' branches that are due, and the one-time offer for branches of cards
 *  shipped before the cleanup existed. Each answer is on the row; opening it
 *  shows Settings › Shipping › Card branches, where the switch is. */
function branchCleanupItems(
  p: PendingBranchCleanup,
  busy: boolean,
  cleanup: ReturnType<typeof useBranchCleanup.getState>,
): InboxItem[] {
  // 1.174.0 (DS2): the switch is in Settings › Shipping › Card branches.
  const openSettings = () =>
    useUi.getState().openSettingsSection("shipping", { workspaceId: p.workspaceId, row: DELETE_CARD_BRANCHES });
  const items: InboxItem[] = [];
  if (p.asks.length > 0) {
    const words = askWords(p.asks);
    const ids = p.asks.map((a) => a.cardId);
    items.push({
      id: `branch-ask:${p.workspaceId}:${ids.join(",")}`,
      dot: "done",
      workspaceName: p.workspaceName,
      title: words.title,
      detail: words.detail,
      at: Math.max(...p.asks.map((a) => a.at)),
      // 1.171.0 A3 (BI-2): keeping is the press; deleting asks first.
      action: words.keep,
      act: () => void cleanup.answerAsk(p.workspaceId, ids, false),
      more: [
        {
          label: words.remove,
          act: () =>
            void confirmChoice(words.deleteAsk).then((answer) => {
              if (answer === "confirm") void cleanup.answerAsk(p.workspaceId, ids, true);
            }),
        },
      ],
      busy,
      seen: false,
      openLabel: OPEN_SETTINGS,
      open: openSettings,
    });
  }
  if (p.backlog.length > 0) {
    const words = backlogWords(p.backlog);
    items.push({
      id: `branch-backlog:${p.workspaceId}`,
      dot: "done",
      workspaceName: p.workspaceName,
      title: words.title,
      detail: words.detail,
      at: p.backlogAt ?? null,
      action: words.yes,
      act: () => void cleanup.answerBacklog(p.workspaceId, "delete"),
      more: [
        { label: words.notNow, act: () => void cleanup.answerBacklog(p.workspaceId, "notNow") },
        { label: words.never, act: () => void cleanup.answerBacklog(p.workspaceId, "never") },
      ],
      busy,
      seen: false,
      openLabel: OPEN_SETTINGS,
      open: openSettings,
    });
  }
  return items;
}

/** QoL 1.168 S1-4: "Ship it" ships this card — its own Ship step, where
 *  Ship now is, on every plan. */
function shipCard(workspaceId: string, cardId: string) {
  openCardStep(workspaceId, cardId, "ship");
}

/** SL-2: open the card (the row's own way in, which marks it seen), then
 *  send what its pull request needs to its Builder, on its session. */
function fixFromInbox(ev: InboxEvent, open: (ev: InboxEvent) => void, cardId: string) {
  open(ev);
  void useBuilder.getState().fixFromGitHub(ev.workspaceId, cardId);
}

/** 1.169.1 (R1): the row's Merge is the card's Merge — the same store
 *  press (`mergePr` → `card_pr_merge`), the same refusals, said in a toast
 *  since the row has no Shipping section to say them in. */
export async function mergeFromInbox(workspaceId: string, cardId: string): Promise<void> {
  // 1.176.2 F2: one Merge of the card at a time, the card page's included.
  await pressOnce(prMergePressKey(workspaceId, cardId), () => mergeFromInboxNow(workspaceId, cardId), sayStillRunning(MERGE_STILL_RUNNING));
}

async function mergeFromInboxNow(workspaceId: string, cardId: string): Promise<void> {
  try {
    const r = await useKanban.getState().mergePr(workspaceId, cardId);
    if (r.refused) {
      pushToast({ kind: "error", title: r.refused, ...(r.github ? { details: r.github } : {}) });
    } else if (r.merged) {
      const n = r.card.pr?.number;
      pushToast({ kind: "info", title: n != null ? `Pull request #${n} merged` : "Pull request merged" });
    }
  } catch (e) {
    // 1.176.2 (E1, A3-13): not every failure is a failure to reach GitHub — the
    // body says which; the title says what didn't happen.
    pushErrorToast("The pull request wasn't merged", e, { then: "Nothing was merged. Try again." });
  }
}

/** G5: the row's Bring this computer up to date is the card's own press;
 *  what it got is said in a toast, as the row's Merge. */
export async function bringUpToDateFromInbox(workspaceId: string, cardId: string): Promise<void> {
  try {
    const r = await useKanban.getState().bringUpToDate(workspaceId, cardId);
    if (r.refused) {
      pushToast({ kind: "error", title: upToDateRefusedLine(r.refused) });
    } else {
      pushToast({ kind: "info", title: machineWords("This Mac is up to date") });
    }
  } catch (e) {
    pushToast({ kind: "error", title: machineWords("Couldn't bring this Mac up to date. Try again."), details: String(e) });
  }
}

/** A row's press on its way (R1's Merge, G5's Bring this computer up to date). */
type RowPress = { busy: boolean; run: (workspaceId: string, cardId: string) => void };

function feedItem(
  ev: ReconciledEvent,
  open: (ev: InboxEvent) => void,
  context: InboxRowContext,
  merge?: RowPress,
  upToDate?: RowPress,
): InboxItem {
  // P-A (UX P1 point 2): a card whose words a rule says (a ship press that
  // failed) reads as its Board card and its page do. Mac walk 2: one that
  // can ship offers Ship it, as its Board card does — on a Board that can.
  const presentedShip = ev.presented?.ship === true && !context.readOnly;
  // F1: the card's own press — the Board's — does what the row did before
  // where it is that press (Merge, Fix with the Builder, Bring this computer
  // up to date, Ship it); any other opens the card, as the Board card does.
  const pressed = ev.presented?.action ?? null;
  const words = ev.presented
    ? {
        detail: ev.presented.detail,
        action: ev.presented.ship && !presentedShip ? SEE_THE_REVIEW_LABEL : pressed,
        ship: presentedShip,
        serious: false,
        fix: pressed === FIX_ACTION && context.fix === true,
        merge: pressed === MERGE_ACTION && context.merge === true,
        upToDate: pressed === BRING_UP_TO_DATE_ACTION,
      }
    : inboxRowWords(ev, context);
  const cardId = ev.cardId;
  return {
    id: ev.id,
    dot: dotOf(ev),
    failure: ev.group === "needs_you" && isFailureRow(ev),
    workspaceName: inboxChipName(ev),
    title: ev.title,
    detail: words.detail,
    at: ev.at,
    action: words.action,
    serious: words.serious,
    ...((words.merge && cardId && merge) || ("upToDate" in words && words.upToDate && cardId && upToDate)
      ? { press: "merge" as const }
      : words.ship && cardId
        ? { press: "ship" as const }
        : {}),
    // A5 round 1: Ship it, Merge, Bring this computer up to date and Fix
    // with the Builder do their own thing; the card is in ⋯.
    ...(cardId &&
    ((words.merge && merge) || ("upToDate" in words && words.upToDate && upToDate) || words.fix || words.ship)
      ? { openLabel: OPEN_THE_CARD }
      : {}),
    act:
      words.merge && cardId && merge
        ? () => merge.run(ev.workspaceId, cardId)
        : "upToDate" in words && words.upToDate && cardId && upToDate
          ? () => upToDate.run(ev.workspaceId, cardId)
          : words.fix && cardId
          ? () => fixFromInbox(ev, open, cardId)
          : words.ship && cardId
            ? () => shipCard(ev.workspaceId, cardId)
            : undefined,
    // A5 (inbox.html scene 2): Merge merges here and says so while it runs.
    ...(words.merge && merge?.busy ? { busy: true, busyAction: "Merging…" } : {}),
    ...("upToDate" in words && words.upToDate && upToDate?.busy ? { busy: true } : {}),
    more: ev.kind === "pr_review" && ev.url ? prLinkExtras(ev.url) : undefined,
    opened: ev.kind === "pr_review",
    // F1 (BI-14): a card's to-do row is never grayed; news leaves once
    // seen. A row with no card counts only while unseen (Challenger 1), so
    // once seen it reads grayed, as it is no longer counted. A5: an ideas
    // row is News that stays, grayed once seen, until its ideas are answered.
    seen: isIdeasRow(ev)
      ? ev.seenAt != null
      : ev.cardId == null && ev.seenEligible && ev.seenAt != null && !isNewsRow(ev),
    open: () => open(ev),
  };
}

function openOnGitHub(url: string) {
  void openWebLink(url).catch((e: unknown) =>
    pushToast(linkDidNotOpen(url, e)),
  );
}

/** QoL 14.2 (F7): a review-requested pull request's quiet extras. */
function prLinkExtras(url: string): { label: string; act: () => void }[] {
  return [
    {
      label: "Open on GitHub",
      act: () => openOnGitHub(url),
    },
    {
      label: "Copy link",
      act: () => {
        navigator.clipboard.writeText(url).catch(() => {});
        pushToast({ kind: "info", title: "Link copied", body: url });
      },
    },
  ];
}

/** Whether a row's card can ship now, and with which checks: the Board's
 *  one rule (`isShipBatchEligible`), never on a read-only Board. */
function shipContext(
  card: KanbanCard | undefined,
  readOnly: boolean,
  fixSent: Record<string, string | undefined>,
): InboxRowContext {
  // SL-2: a pull request its Builder can fix.
  // Walk I4: not again once a fix for what GitHub says now is with the Builder.
  if (card && !readOnly && prFixOffered(card, fixSent[card.id])) {
    return { ship: null, fix: true };
  }
  // 1.169.1 (R1): a pull request ready to merge, whose Now offers Merge.
  if (card && !readOnly && prCardReadyToMerge(card) && prMergeReady(card)) {
    return { ship: null, merge: true };
  }
  const batch = card ? isShipBatchEligible(card) : false;
  if (!card || readOnly || !batch) return { ship: null, readOnly, batch };
  // GH #333: a pass with no checks set up never reads "checks passed".
  return { ship: readyToShipChecks(card), readOnly, batch };
}

/** F1 (BI-7): one On hold row per workspace for two or more cards that
 *  Plyloft's quit paused ("3 cards paused when Plyloft closed"); it opens
 *  that workspace's Board. One card keeps its own row, with Resume. */
export function groupPaused(items: readonly InboxItem[]): InboxItem[] {
  const byWs = new Map<string, InboxItem[]>();
  for (const i of items) {
    if (!i.paused) continue;
    const list = byWs.get(i.paused.workspaceId) ?? [];
    list.push(i);
    byWs.set(i.paused.workspaceId, list);
  }
  const out: InboxItem[] = [];
  const done = new Set<string>();
  for (const i of items) {
    const ws = i.paused?.workspaceId;
    const list = ws ? byWs.get(ws) : undefined;
    if (!ws || !list || list.length < 2) {
      out.push(i);
      continue;
    }
    if (done.has(ws)) continue;
    done.add(ws);
    const words = pausedRowWords(list.map((x) => x.paused!.title));
    const openBoard = () => {
      const workspaces = useWorkspaces.getState();
      if (workspaces.activeId !== ws) void workspaces.setActive(ws);
      openCenterMode(ws, "board");
    };
    out.push({
      id: `paused:${ws}`,
      dot: "empty",
      workspaceName: list[0].workspaceName,
      title: words.title,
      detail: words.detail,
      at: Math.max(...list.map((x) => x.at ?? 0)) || null,
      action: GO_TO_THE_BOARD,
      act: openBoard,
      cards: list.length,
      seen: false,
      open: openBoard,
    });
  }
  return out;
}

export function InboxPanel() {
  const loading = useInbox((s) => s.loading);
  const error = useInbox((s) => s.error);
  const refresh = useInbox((s) => s.refresh);
  const readItAgain = useInbox((s) => s.readItAgain);
  const markSeen = useInbox((s) => s.markSeen);
  const open = useInbox((s) => s.open);
  const activeId = useWorkspaces((s) => s.activeId);
  const workspaces = useWorkspaces((s) => s.workspaces);
  const visible = usePageVisible();
  const now = useNow();
  // The sentence's numbers are the sidebar's (`lib/needsYou.ts`
  // `attentionCounts`): they add up to the Inbox row's count.
  // P-A (UX P1 point 2): the rows are the feed as the loaded cards say it
  // (`lib/inboxReconcile.ts`), the one the counts read too.
  const { waiting, needs, feed, builderWaiting } = useNeedsYou(now);
  const boards = useKanban((s) => s.byWorkspace);
  const licensed = useTeamAllowed();
  const fixSent = useBuilder((s) => s.fixSent);
  const cleanupPending = useBranchCleanup((s) => s.pending);
  // P-A: each card row carries its card's rule, as its Board card does —
  // (Challenger) from the same live tip as the Board card, so the two agree
  // on a commit made after the review too.
  // UX P-B Mac walk 2: with the waiting Builders the rows were derived
  // from (this render's live sessions), not the store's a tick behind — a
  // question's row and its card's rule agree from the first frame.
  const presenter = useCardPresenter(builderWaiting);
  const feedCards = useMemo(() => {
    const out: KanbanCard[] = [];
    const seen = new Set<string>();
    const add = (ws: string, id: string) => {
      const card = boards[ws]?.cards.find((c) => c.id === id);
      if (card && !seen.has(`${ws}::${id}`)) {
        seen.add(`${ws}::${id}`);
        out.push(card);
      }
    };
    for (const ev of feed?.events ?? []) if (ev.cardId && ev.group !== "shipped") add(ev.workspaceId, ev.cardId);
    for (const s of waiting) if (s.target.kind === "card") add(s.workspaceId, s.target.cardId);
    return out;
  }, [feed, waiting, boards]);
  const tips = useLiveReviewTips(feedCards);
  const presentOf = useCallback(
    (card: KanbanCard) => presenter(card, tips.get(card.id) ?? null),
    [presenter, tips],
  );
  const cleanupBusy = useBranchCleanup((s) => s.busy);
  // R1: the rows whose Merge is on its way to GitHub.
  const [merging, setMerging] = useState<Record<string, boolean>>({});
  const runMerge = useCallback((workspaceId: string, cardId: string) => {
    const k = `${workspaceId}::${cardId}`;
    setMerging((m) => ({ ...m, [k]: true }));
    void mergeFromInbox(workspaceId, cardId).finally(() =>
      setMerging((m) => {
        const { [k]: _gone, ...rest } = m;
        return rest;
      }),
    );
  }, []);
  // G5: the rows whose Bring this computer up to date is running.
  const [updating, setUpdating] = useState<Record<string, boolean>>({});
  const runUpToDate = useCallback((workspaceId: string, cardId: string) => {
    const k = `${workspaceId}::${cardId}`;
    setUpdating((m) => ({ ...m, [k]: true }));
    void bringUpToDateFromInbox(workspaceId, cardId).finally(() =>
      setUpdating((m) => {
        const { [k]: _gone, ...rest } = m;
        return rest;
      }),
    );
  }, []);

  // Fetch on mount if the startup fetch hasn't landed yet, then keep PRs
  // fresh with a visible-gated interval while the page is on screen.
  useEffect(() => {
    if (!visible) return;
    void refresh();
    const id = window.setInterval(() => void refresh(), PANEL_POLL_MS);
    return () => window.clearInterval(id);
  }, [visible, refresh]);

  // N18: the card-branch cleanup's questions — read when the page is on
  // screen, and again when a board changes (a sweep, an answer, an archive).
  useEffect(() => {
    if (!visible) return;
    const cleanup = useBranchCleanup.getState();
    void cleanup.refresh();
    const id = window.setInterval(() => void cleanup.refresh(), PANEL_POLL_MS);
    let unlisten: (() => void) | null = null;
    let gone = false;
    void onKanbanChanged(() => void useBranchCleanup.getState().refresh()).then((u) => {
      if (gone) u();
      else unlisten = u;
    });
    return () => {
      gone = true;
      window.clearInterval(id);
      unlisten?.();
    };
  }, [visible]);

  // 1.173.0 (B2): a card's row names its area beside the workspace, where
  // the workspace has two areas or more.
  const areaViews = useAreas((s) => s.views);
  useEffect(() => {
    if (visible) ensureAreasRead(workspaces.map((w) => w.id));
  }, [visible, workspaces]);

  const groups = useMemo(() => {
    const nameOf = (id: string) => workspaces.find((w) => w.id === id)?.name || "A workspace";
    const chipOf = (item: InboxItem, workspaceId: string, card: KanbanCard) =>
      withAreaName(item.workspaceName, areaViews[workspaceId], cardAreaOf(card));
    const map: Record<InboxPageGroup, InboxItem[]> = {
      needs_you: [
        ...waiting.map((s) => {
          const item = waitingItem(s, nameOf(s.workspaceId));
          // (Challenger) A card's session row is that card's row in the
          // Inbox (its Rust row is folded into it): it carries the rule.
          const card =
            s.target.kind === "card" ? boards[s.workspaceId]?.cards.find((c) => c.id === (s.target as { cardId: string }).cardId) : undefined;
          if (!card) return item;
          const p = presentOf(card);
          // Mac walk 5: a question the card speaks for (the folder-trust
          // question) has the card's dot; a session merely at its prompt
          // keeps the waiting row's own.
          const workspaceName = chipOf(item, s.workspaceId, card);
          // F1 (BI-11): a Builder waiting on its turn or a plain question is
          // its Board card — its title, its headline and the Board's press. A
          // named question (trust, a usage limit, an intake, a plan) keeps its
          // own words, which already say the card's and more (a reset time).
          const press = boardNextPress(p);
          const asCard =
            s.question == null
              ? { title: card.title, detail: p.headline, ...(press ? { action: press } : {}) }
              : {};
          return cardSessionWords(p, undefined)
            ? { ...item, ...asCard, workspaceName, rule: p.rule, dot: cardDot(p) }
            : { ...item, ...asCard, workspaceName, rule: p.rule };
        }),
        ...cleanupPending.flatMap((p) =>
          branchCleanupItems(p, cleanupBusy[p.workspaceId] ?? false, useBranchCleanup.getState()),
        ),
      ],
      running: [],
      on_hold: [],
      scheduled: [],
      news: [],
    };
    for (const ev of feed?.events ?? []) {
      // F1: news until seen (Clear the news, or opening it); ships are the
      // History line below. A5: an ideas row is News, seen or not.
      const news = onNewsShelf(ev);
      if (!news && (ev.group === "shipped" || ev.group === "news")) continue;
      const group: InboxPageGroup = news ? "news" : (ev.group as InboxPageGroup);
      // A group this page doesn't draw (none today) is left out, not a crash.
      if (!map[group]) continue;
      const ws = workspaces.find((w) => w.id === ev.workspaceId);
      const readOnly = ws?.kanbanSyncMode === "githubIssues" && !licensed;
      const card = ev.cardId
        ? boards[ev.workspaceId]?.cards.find((c) => c.id === ev.cardId)
        : undefined;
      // QoL 14.2 (F7): a review-requested pull request — does its review
      // card exist on the loaded Board?
      const pr = ev.kind === "pr_review" ? prOfInboxId(ev.id) : null;
      const context = pr
        ? { prCard: reviewCardOf(boards[ev.workspaceId]?.cards ?? [], pr) != null }
        : shipContext(card, readOnly, fixSent);
      // QoL 1.168 (F10): the chip names the workspace even when the row's
      // own name is empty (a row the frontend added for a loaded card).
      const item = feedItem(ev.workspaceName ? ev : { ...ev, workspaceName: nameOf(ev.workspaceId) }, open, context, {
        busy: Boolean(ev.cardId && merging[`${ev.workspaceId}::${ev.cardId}`]),
        run: runMerge,
      }, {
        busy: Boolean(ev.cardId && updating[`${ev.workspaceId}::${ev.cardId}`]),
        run: runUpToDate,
      });
      // Challenger 6: only a card Plyloft's quit paused groups; a queued
      // card is its own On hold row.
      const paused =
        group === "on_hold" && ev.kind === "card_running" && ev.detail === PAUSED_ON_CLOSE_DETAIL
          ? { paused: { workspaceId: ev.workspaceId, title: ev.title } }
          : {};
      if (!card) {
        // G2 walk (Mac): a release row names its area, from its tag.
        // A plain vX.Y.Z is the first area's (as the sidebar's row reads it).
        const releaseAreas = areaViews[ev.workspaceId]?.areas ?? [];
        const releaseArea =
          ev.kind === "released" || ev.kind === "release_stopped"
            ? (areaOfTag(releaseAreas, ev.title.split(" ")[0] ?? "") ?? (releaseAreas.length >= 2 ? releaseAreas[0].id : null))
            : null;
        map[group].push({
          ...item,
          ...paused,
          ...(releaseArea ? { workspaceName: withAreaName(item.workspaceName, areaViews[ev.workspaceId], releaseArea) } : {}),
        });
        continue;
      }
      const p = presentOf(card);
      map[group].push({ ...item, ...paused, workspaceName: chipOf(item, ev.workspaceId, card), rule: p.rule, dot: cardDot(p) });
    }
    // F1 (BI-10): a failure comes first in Needs you (stable otherwise).
    // A5 (scene 1): then Merge, then Ship it — the order says where to start.
    map.needs_you = needsYouOrder(map.needs_you);
    // F1 (BI-7): two cards or more Plyloft's quit paused are one row per
    // workspace; it opens the Board, where each card has its Resume.
    map.on_hold = groupPaused(map.on_hold);
    return map;
  }, [feed, open, waiting, workspaces, boards, licensed, fixSent, cleanupPending, cleanupBusy, presentOf, merging, runMerge, updating, runUpToDate, areaViews]);

  // F1: Clear the news takes only the news rows; what needs you stays.
  const newsIds = newsRowIds(feed?.events ?? []);
  const shipped = shippedThisWeek(feed?.events ?? [], now);
  // A5 round 1 (inbox.html scene 4): News asks nothing, so with only news
  // the page says Nothing needs you, its one way out, then the News.
  const empty = INBOX_GROUPS.every(({ key }) => key === "news" || groups[key].length === 0);
  // F1 (BI-7): On hold counts its cards, a grouped row as all of them.
  const onHoldCards = groups.on_hold.reduce((n, i) => n + (i.cards ?? 1), 0);
  const [recentOpen, setRecentOpen] = useState(false);

  return (
    <div className="ux-inbox">
      {/* UX-3.5: the screen header; Refresh sits in the ⋯ (F1: Clear the news
          is News's own). The count lives on the sidebar's Inbox row. */}
      <ModeHeader
        mode="inbox"
        actions={
          <>
            <MoreMenu
              label="More for the Inbox"
              items={[
                {
                  label: loading ? "Refreshing…" : "Refresh",
                  disabled: loading,
                  onSelect: () => void refresh(),
                },
                // QoL 1.168 block 8 (A2): the last ten toasts, readable again.
                { label: "Recent messages", onSelect: () => setRecentOpen(true) },
              ]}
            />
          </>
        }
      />
      <Page wide>
        {/* QoL 1.168 (F11): before the first feed lands, say so — the
            page is never blank, then it says empty or what needs you. */}
        {!feed && !error && <p className="ux-inbox-lede">Loading the Inbox…</p>}
        {feed && !empty && (
          <p className="ux-inbox-lede">
            {inboxSummary({
              needs,
              running: groups.running.length,
              onHold: onHoldCards,
              scheduled: groups.scheduled.length,
            })}
          </p>
        )}
        {/* F1 (BI-13): the empty Inbox says so, and where to go. */}
        {feed && empty && (
          <div className="ux-inbox-empty" data-ply-inbox-empty="">
            <p className="ux-inbox-empty-title">{INBOX_EMPTY_TITLE}</p>
            <p className="ux-inbox-lede">{INBOX_EMPTY_SENTENCE}</p>
            {activeId && (
              <CBtn onClick={() => openCenterMode(activeId, "board")}>{GO_TO_THE_BOARD}</CBtn>
            )}
          </div>
        )}
        {/* 1.176.3: a read that failed can be read again, in place. */}
        {error && (
          <Callout
            kind="warn"
            text={error}
            actions={<ReadAgainButton pressKey="inbox-read" label={READ_IT_AGAIN} run={readItAgain} busy={loading} />}
          />
        )}
        {activeId && <ReopenPointer workspaceId={activeId} />}
        {INBOX_GROUPS.map(({ key, label }) => (
          <InboxGroupSection
            key={key}
            label={label}
            items={groups[key]}
            count={inboxSectionCount(key, key === "on_hold" ? onHoldCards : groups[key].length, needs)}
            now={now}
            action={
              key === "news" && newsIds.length > 0 ? (
                <CBtn tone="quiet" size="sm" title={CLEAR_THE_NEWS_TITLE} onClick={() => void markSeen(newsIds)}>
                  {CLEAR_THE_NEWS}
                </CBtn>
              ) : undefined
            }
          />
        ))}
        {shipped > 0 && activeId && (
          <CBtn
            tone="quiet"
            className="ux-inbox-history"
            onClick={() => openCenterMode(activeId, "activity")}
          >
            <Icon name="history" />
            <span className="ux-inbox-history-text">
              {shipped} shipped this week · History
            </span>
            <Icon name="opens" />
          </CBtn>
        )}
      </Page>
      {recentOpen && <RecentMessagesSheet onClose={() => setRecentOpen(false)} />}
    </div>
  );
}

/** 1.169.0 (C3): the sessions open when Plyloft quit are offered in
 *  Terminals (`ReopenSessionsOffer`); the Inbox points there, so the offer
 *  is seen wherever Plyloft opens. Gone with the offer (reopened, Not now,
 *  each back in a tile, or — F3 — a session opened in the workspace). */
function ReopenPointer({ workspaceId }: { workspaceId: string }) {
  const env = useDoctor((s) => s.env);
  const { offered } = useReopenOffer(workspaceId, env);
  if (offered.length === 0) return null;
  return (
    <CBtn
      tone="quiet"
      className="ux-inbox-history"
      title={reopenList(offered)}
      onClick={() => openCenterMode(workspaceId, "terminals")}
    >
      <Icon name="terminals" />
      <span className="ux-inbox-history-text">{reopenPointerWords(offered.length)}</span>
      <Icon name="opens" />
    </CBtn>
  );
}

function InboxGroupSection({
  label,
  items,
  count,
  now,
  action,
}: {
  label: string;
  items: readonly InboxItem[];
  count: string | null;
  now: number;
  action?: ReactNode;
}) {
  const [all, setAll] = useState(false);
  if (items.length === 0) return null;
  const shown = all ? items : items.slice(0, INBOX_GROUP_CAP);
  return (
    <Section title={label} count={count} countInline action={action}>
      <Group label={label}>
        {shown.map((item) => (
          <InboxRow key={item.id} item={item} now={now} />
        ))}
      </Group>
      {items.length > INBOX_GROUP_CAP && (
        <CBtn tone="quiet" size="sm" className="ux-inbox-more" onClick={() => setAll(!all)}>
          {all ? "Show fewer" : `Show all ${items.length}`}
        </CBtn>
      )}
    </Section>
  );
}

/**
 * One Inbox row, as a ux `Row` in the section's `Group` (A0, the tidy-table
 * rule): the dot, the workspace and the title as its label, the detail as
 * its hint, when as its value, the one action (bordered: A5, P16), and the
 * row's other answers in its ⋯. A row with no action opens on a press of its
 * label, with the chevron. The row stays a mouse target for its card.
 */
function InboxRow({ item, now }: { item: InboxItem; now: number }) {
  // N19: the detail shows up to two lines; its full text is its tooltip and
  // describes the row's buttons, so a clamped sentence is never lost.
  const detailId = useId();
  const describedBy = item.detail ? detailId : undefined;
  const moreItems = [
    ...(item.more ?? []).map((m) => ({ label: m.label, onSelect: m.act })),
    ...(item.action && item.openLabel ? [{ label: item.openLabel, onSelect: item.open }] : []),
  ];
  const label = (
    <span className="ux-inbox-label">
      <span className={DOT_CLASS[item.dot]} aria-hidden="true" />
      <PChip>{item.workspaceName}</PChip>
      <span className="ux-inbox-title">{item.title}</span>
    </span>
  );
  return (
    <Row
      kind="item"
      muted={item.seen}
      label={label}
      hint={
        item.detail ? (
          <span
            id={detailId}
            className={item.serious ? "ux-inbox-detail ux-inbox-detail--serious" : "ux-inbox-detail"}
            title={item.detail}
          >
            {item.detail}
          </span>
        ) : undefined
      }
      onOpen={item.action ? undefined : item.open}
      onPress={item.action ? item.open : undefined}
      action={
        item.action ? (
          <CBtn
            size="sm"
            disabled={item.busy}
            aria-describedby={describedBy}
            data-ply-rule={item.rule}
            onClick={item.act ?? item.open}
          >
            {item.busy && item.busyAction ? item.busyAction : machineWords(item.action)}
          </CBtn>
        ) : undefined
      }
      more={
        moreItems.length ? (
          <MoreMenu label={`More for ${item.title}`} disabled={item.busy} items={moreItems} />
        ) : undefined
      }
    >
      <span className="ux-inbox-when">{item.opened ? prOpenedWords(item.at, now) : inboxWhen(item.at, now)}</span>
    </Row>
  );
}
