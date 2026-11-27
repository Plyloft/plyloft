import { create } from "zustand";
import {
  branchBacklogAnswer,
  branchCleanupAnswer,
  branchCleanupPending,
  onKanbanChanged,
  type PendingBranchCleanup,
} from "../ipc";
import { answerToast } from "../lib/branchCleanup";
import { pushToast } from "./toastStore";
import { pushErrorToast } from "../lib/errorToast";

/**
 * N18: what the card-branch cleanup asks of the person, per workspace — the
 * archived cards' branches that are due (Delete them / Keep them) and the
 * one-time offer for branches of cards shipped before the cleanup existed
 * (Delete N branches / Not now / Never). Read from `branch_cleanup_pending`
 * by the Inbox page, which draws them as Needs you rows; the decisions and
 * every safety check are the backend's (`branch_cleanup.rs`).
 */
type BranchCleanupStore = {
  pending: PendingBranchCleanup[];
  /** Workspaces with an answer on its way. */
  busy: Record<string, boolean>;
  refresh: () => Promise<void>;
  answerAsk: (workspaceId: string, cardIds: string[], del: boolean) => Promise<void>;
  answerBacklog: (workspaceId: string, answer: "delete" | "notNow" | "never") => Promise<void>;
};

export const useBranchCleanup = create<BranchCleanupStore>((set, get) => {
  async function answer(workspaceId: string, call: () => Promise<{ deleted: number; kept: number; queued: number }>, quiet: boolean) {
    if (get().busy[workspaceId]) return;
    set((s) => ({ busy: { ...s.busy, [workspaceId]: true } }));
    try {
      const result = await call();
      if (!quiet) pushToast({ kind: "info", title: "Card branches", body: answerToast(result) });
    } catch (e) {
      pushErrorToast("Couldn't clean up the branches", e);
    } finally {
      set((s) => ({ busy: { ...s.busy, [workspaceId]: false } }));
      await get().refresh();
    }
  }
  return {
    pending: [],
    busy: {},
    refresh: async () => {
      try {
        set({ pending: (await branchCleanupPending()) ?? [] });
      } catch (e) {
        console.warn("branch cleanup: reading what is pending failed:", e);
      }
    },
    answerAsk: (workspaceId, cardIds, del) =>
      answer(workspaceId, () => branchCleanupAnswer(workspaceId, cardIds, del), !del),
    answerBacklog: (workspaceId, choice) =>
      answer(workspaceId, () => branchBacklogAnswer(workspaceId, choice), choice !== "delete"),
  };
});

/** How many Needs you rows the cleanup adds, per workspace. */
export function branchCleanupCounts(pending: readonly PendingBranchCleanup[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of pending) {
    const n = (p.asks.length > 0 ? 1 : 0) + (p.backlog.length > 0 ? 1 : 0);
    if (n > 0) out[p.workspaceId] = n;
  }
  return out;
}

let subscribed = false;
let debounce: ReturnType<typeof setTimeout> | null = null;

/**
 * Challenger M3: read what the cleanup asks at startup and again whenever a
 * board changes (a sweep, an answer, an archive), so the sidebar's Inbox
 * count includes the asks without the Inbox ever being opened. Call once
 * from App startup.
 */
export function startBranchCleanupSubscriptions() {
  if (subscribed) return;
  subscribed = true;
  void onKanbanChanged(() => {
    if (debounce !== null) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      void useBranchCleanup.getState().refresh();
    }, 500);
  });
  void useBranchCleanup.getState().refresh();
}

/** Tests: forget the startup wiring. */
export function stopBranchCleanupSubscriptionsForTests() {
  subscribed = false;
  if (debounce !== null) clearTimeout(debounce);
  debounce = null;
}
