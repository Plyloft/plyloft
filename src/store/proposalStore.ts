import { create } from "zustand";
import {
  improvementProposalApprove,
  improvementProposalDismiss,
  improvementProposalState,
  improvementProposalTrustStopped,
  onImprovementProposalChanged,
} from "../ipc";
import { useWorkspaces } from "./workspaceStore";
import type { ProposalApproved, ProposalView } from "../lib/proposals";

/**
 * UX language card 8 (GH #104, ADR 0005): the workspace's improvement proposal,
 * per workspace, in one place.
 *
 * Three surfaces show it — the block on the target's Library page, the Inbox
 * item and the card's Ship step — and they read **this**, not three fetches of
 * their own: a proposal dropped for staleness is dropped by the backend on the
 * first read, so a second reader would find nothing where the first found
 * something and the two would disagree on screen.
 *
 * Keyed by `workspaceId` throughout (AGENTS.md), because a proposal is about one
 * repository's own skills and instructions. Nothing here is persisted — the
 * proposal itself lives in `projects/<ws>/improvement_proposal.json`, written in
 * Rust — so there is no schema to migrate.
 */
export interface WorkspaceProposal {
  /** `undefined` while the first read is in flight; `null` once it answered. */
  view?: ProposalView | null;
  loading: boolean;
  /** What a write refused, for the surface that asked. */
  error: string | null;
  /**
   * SP-5: what the last approval of a workspace with no shared definition did,
   * in its own words, for the surface's toast. `null`/absent: the shared
   * channel took it, and the surface says its own words.
   */
  approved?: ProposalApproved | null;
  /** The card whose last proposal pass stopped at Claude's trust question
   *  (`improvementProposalTrustStopped`): it shows the trust step where its
   *  proposal would appear. The one failure of a pass that is shown. */
  trustStoppedCard?: string | null;
}

interface ProposalStore {
  byWorkspace: Record<string, WorkspaceProposal>;
  /** Read it again. Safe to call from every surface: one read at a time. */
  refresh: (workspaceId: string) => Promise<void>;
  /** `Approve`. Resolves `true` when the change was answered: queued on the
   *  shared channel, or (SP-5, no shared definition) committed, published or
   *  sent to a pull request — `approved` then says which. */
  approve: (workspaceId: string) => Promise<boolean>;
  /** `Dismiss`: forget it. */
  dismiss: (workspaceId: string) => Promise<boolean>;
  reset: (workspaceId: string) => void;
}

const EMPTY: WorkspaceProposal = { loading: false, error: null };

function patch(
  state: ProposalStore,
  workspaceId: string,
  next: Partial<WorkspaceProposal>,
): Pick<ProposalStore, "byWorkspace"> {
  const was = state.byWorkspace[workspaceId] ?? EMPTY;
  return { byWorkspace: { ...state.byWorkspace, [workspaceId]: { ...was, ...next } } };
}

let subscribed = false;

/**
 * GH #104 review 2 (R6): subscribe **at app level**, like `inboxStore`.
 *
 * The first version listened inside `LibraryModeHost`, which only exists while
 * the Library is a workspace's visible mode — so the card's Ship step showed no
 * line until somebody had visited the Library, and the Inbox row (a backend view)
 * and the Ship line disagreed. The store is the one reader for all three
 * surfaces, so the one subscription belongs with it. Called once from App
 * startup.
 */
export function startProposalSubscriptions(): void {
  if (subscribed) return;
  subscribed = true;
  void onImprovementProposalChanged((workspaceId) => {
    void useProposal.getState().refresh(workspaceId);
  });
  // The active workspace's proposal, before any surface asks: the Ship step of a
  // card opened straight from the Inbox must already know.
  const active = useWorkspaces.getState().activeId;
  if (active) void useProposal.getState().refresh(active);
  useWorkspaces.subscribe((state, previous) => {
    if (state.activeId && state.activeId !== previous.activeId) {
      void useProposal.getState().refresh(state.activeId);
    }
  });
}

/** Workspaces whose `refresh` was asked for while a read was out. */
const readAgain = new Set<string>();

export const useProposal = create<ProposalStore>((set, get) => ({
  byWorkspace: {},

  refresh: async (workspaceId) => {
    // A read asked for while one is out (an event during it) runs once that
    // one has landed, so its answer is never lost or overtaken.
    if (get().byWorkspace[workspaceId]?.loading) {
      readAgain.add(workspaceId);
      return;
    }
    set((s) => patch(s, workspaceId, { loading: true }));
    // The card whose last pass stopped at Claude's trust question: a file
    // read beside the proposal's, unreadable = none (silent like the rest),
    // landing in the same update as the proposal.
    const trustRead = (async () => {
      try {
        return (await improvementProposalTrustStopped(workspaceId)) ?? null;
      } catch {
        return null;
      }
    })();
    let next: Partial<WorkspaceProposal>;
    try {
      next = { view: await improvementProposalState(workspaceId), error: null };
    } catch (cause) {
      // A proposal nobody asked for that could not be read is not news: the
      // surfaces simply show nothing, as they do for the many cards that get
      // no proposal at all. The reason stays in the record for a write to say.
      next = { view: null, error: String((cause as Error)?.message ?? cause) };
    }
    const trustStoppedCard = await trustRead;
    set((s) => patch(s, workspaceId, { ...next, trustStoppedCard, loading: false }));
    if (readAgain.delete(workspaceId)) void get().refresh(workspaceId);
  },

  approve: async (workspaceId) => {
    set((s) => patch(s, workspaceId, { loading: true, error: null, approved: null }));
    try {
      const approved = await improvementProposalApprove(workspaceId);
      // It has been answered: the block goes, and the Inbox and the Ship step
      // go with it, because they read this.
      set((s) => patch(s, workspaceId, { view: null, loading: false, approved: approved ?? null }));
      return true;
    } catch (cause) {
      set((s) =>
        patch(s, workspaceId, {
          loading: false,
          error: String((cause as Error)?.message ?? cause),
        }),
      );
      return false;
    }
  },

  dismiss: async (workspaceId) => {
    set((s) => patch(s, workspaceId, { loading: true, error: null }));
    try {
      await improvementProposalDismiss(workspaceId);
      set((s) => patch(s, workspaceId, { view: null, loading: false }));
      return true;
    } catch (cause) {
      set((s) =>
        patch(s, workspaceId, {
          loading: false,
          error: String((cause as Error)?.message ?? cause),
        }),
      );
      return false;
    }
  },

  reset: (workspaceId) =>
    set((s) => {
      if (!(workspaceId in s.byWorkspace)) return s;
      const next = { ...s.byWorkspace };
      delete next[workspaceId];
      return { byWorkspace: next };
    }),
}));
