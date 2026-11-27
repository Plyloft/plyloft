import { create } from "zustand";
import { dismissToast, pushToast } from "./toastStore";
import { EMPTY_BOARD_FILTER, type BoardFilter } from "../lib/boardFilter";

/**
 * UX revamp C5: the Board's viewer state, per workspace and session-only —
 * like `selectedCardId` it is not a property of any card, and it is not
 * written to disk (a new launch opens every Board on its columns).
 */
export type BoardView = "board" | "list";

/** QoL 14.2 (F7): the Inbox's Review it with the Challenger, for one Board. */
export interface PrReviewAsk {
  workspaceId: string;
  number: number;
  at: number;
}

/** How long an Inbox ask may wait for its Board to show. */
export const PR_REVIEW_ASK_MS = 2 * 60_000;

/** Whether an ask is still the person's (not left over). */
export function prReviewAskFresh(ask: PrReviewAsk, now: number): boolean {
  return now - ask.at >= 0 && now - ask.at <= PR_REVIEW_ASK_MS;
}

interface BoardStore {
  /** Board | List (UX-5.6); a workspace with no entry shows the Board. */
  view: Record<string, BoardView>;
  setView: (workspaceId: string, view: BoardView) => void;
  /** UX-5.7: "Find a card" and the filters; a workspace with no entry has
   *  none. Both views read the same one. */
  filter: Record<string, BoardFilter>;
  setFilter: (workspaceId: string, patch: Partial<BoardFilter>) => void;
  clearFilter: (workspaceId: string) => void;
  /** UX-5.9: cards deleted or archived a moment ago, hidden while their
   *  Undo is on screen; the write happens when the window ends. */
  pendingRemoval: Record<string, "archive" | "delete">;
  /** QoL 14.2 (F7): "Review it with the Challenger" from the Inbox — the
   *  Board of `workspaceId` opens its Review a pull request sheet with that
   *  pull request picked, then clears it. `at` stamps it: an ask older than
   *  `PR_REVIEW_ASK_MS` (its Board never showed) is dropped, never opened. */
  prReviewAsk: PrReviewAsk | null;
  setPrReviewAsk: (ask: PrReviewAsk | null) => void;
}

export const useBoard = create<BoardStore>((set) => ({
  view: {},
  setView: (workspaceId, view) =>
    set((s) => ({ view: { ...s.view, [workspaceId]: view } })),
  filter: {},
  setFilter: (workspaceId, patch) =>
    set((s) => ({
      filter: {
        ...s.filter,
        [workspaceId]: { ...(s.filter[workspaceId] ?? EMPTY_BOARD_FILTER), ...patch },
      },
    })),
  clearFilter: (workspaceId) =>
    set((s) => ({ filter: { ...s.filter, [workspaceId]: EMPTY_BOARD_FILTER } })),
  pendingRemoval: {},
  prReviewAsk: null,
  setPrReviewAsk: (prReviewAsk) => set({ prReviewAsk }),
}));

/** UX-5.9: how long a delete or an archive can be undone — the ToastBar's
 *  6 s Undo (GH #296). */
export const UNDO_WINDOW_MS = 6000;

const pendingTimers = new Map<string, number>();

function settle(cardId: string): void {
  pendingTimers.delete(cardId);
  useBoard.setState((s) => {
    const { [cardId]: _gone, ...rest } = s.pendingRemoval;
    return { pendingRemoval: rest };
  });
}

/**
 * UX-5.9: delete or archive with Undo — the safe way round with a backend
 * whose delete is final (it removes the worktree and the attachments) and
 * whose archive prunes the worktree. The card leaves the Board at once and
 * the toast offers Undo; nothing is written until the window ends. Undo
 * cancels the write, so there is nothing to put back. A quit inside the
 * window leaves the card as it was.
 */
export function deferCardRemoval(opts: {
  cardId: string;
  kind: "archive" | "delete";
  title: string;
  body?: string;
  commit: () => Promise<unknown>;
}): void {
  const { cardId, kind, commit } = opts;
  if (pendingTimers.has(cardId)) return;
  useBoard.setState((s) => ({
    pendingRemoval: { ...s.pendingRemoval, [cardId]: kind },
  }));
  const toastId = pushToast({
    kind: "info",
    title: opts.title,
    body: opts.body,
    action: {
      label: "Undo",
      ttlMs: UNDO_WINDOW_MS,
      onClick: () => {
        const timer = pendingTimers.get(cardId);
        if (timer === undefined) return;
        window.clearTimeout(timer);
        settle(cardId);
      },
    },
  });
  const timer = window.setTimeout(() => {
    // The window is over: the Undo goes with it, then the write.
    dismissToast(toastId);
    pendingTimers.delete(cardId);
    void commit()
      .catch(() => {})
      .finally(() => settle(cardId));
  }, UNDO_WINDOW_MS);
  pendingTimers.set(cardId, timer);
}

/** Test-only: a removal still in its Undo window is dropped, unwritten. Its
 *  timer would otherwise fire in a later test, against that test's board, and
 *  its mark would hide that test's card. */
export function resetCardRemovalsForTests(): void {
  for (const timer of pendingTimers.values()) window.clearTimeout(timer);
  pendingTimers.clear();
  useBoard.setState({ pendingRemoval: {} });
}
