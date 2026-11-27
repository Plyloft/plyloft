import { create } from "zustand";

/**
 * UX language card 8 (GH #103; PATTERNS.md §6): which flow Settings has open.
 *
 * A flow is "a focused surface (same shell, **no navigation**) with what will
 * change and a single confirming action". The navigation is the Settings
 * shell's, not the page's, so the page cannot hide it on its own — the way the
 * Library's `PromoteFlow` and `InstructionsFlow` do it is to put the flow in a
 * store the host reads, and this is Settings' copy of that slot.
 *
 * It holds an id, not a component: the page that owns the procedure draws its
 * own flow, and this only says which one is up and that the navigation beside
 * it goes away.
 */

export type SettingsFlowId =
  /** Team › `Join or create a team` — which way in. */
  | "join-team"
  /** Team › `Create a team` — the owner's one step. */
  | "create-team"
  /**
   * Board › `Back the board with GitHub Issues` — which repository.
   *
   * GH #103 review 1 (BLOCKER): this was a row on the page with a field in it,
   * and the field saved on blur, so clicking away from a half-typed name moved
   * the board to the wrong repository and created labels there. It is a flow
   * now: a question with one confirming action, Esc to abandon it, and no way
   * for looking away to answer it.
   */
  | "board-repo";

interface SettingsFlowState {
  flow: SettingsFlowId | null;
  open: (flow: SettingsFlowId) => void;
  close: () => void;
}

export const useSettingsFlow = create<SettingsFlowState>((set) => ({
  flow: null,
  open: (flow) => set({ flow }),
  close: () => set({ flow: null }),
}));

/** Leaving the page, or Settings itself, takes the flow with it: a flow left
 *  standing would be the first thing on the next page, about something the
 *  reader has moved on from. */
export function closeSettingsFlow(): void {
  if (useSettingsFlow.getState().flow !== null) useSettingsFlow.getState().close();
}
