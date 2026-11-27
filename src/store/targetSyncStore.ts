import { create } from "zustand";
import { cardBringInTarget, cardsTargetSync, type TargetSyncReport } from "../ipc";
import { cardInWorkspace } from "../lib/cardClaim";
import { plainFailure } from "../lib/plainError";
import { prOpen } from "../lib/prStatus";
import { bringInToast } from "../lib/targetSync";
import { cardWorkChanged } from "./errorBlockStore";
import { useBuilder } from "./builderStore";
import { forgetSentToGitHub } from "./sentToGitHubStore";
import { useKanban } from "./kanbanStore";
import { pushToast } from "./toastStore";

/**
 * 1.170.0 (G6): each workspace's reading of how far its cards are behind
 * GitHub's target branch (`cards_target_sync`), read by the Board's badge
 * and the card page's line. In memory, never persisted. The Board reads it
 * every few minutes and a card page when it opens (the backend bounds and
 * throttles the fetch); nothing here changes a card except the person's
 * press of Bring in the target's changes.
 */
type TargetSyncStore = {
  byWorkspace: Record<string, TargetSyncReport | undefined>;
  /** Cards whose Bring in is under way. */
  pressing: Record<string, true | undefined>;
  refresh: (workspaceId: string, opened: boolean) => Promise<void>;
  bringIn: (workspaceId: string, cardId: string) => Promise<void>;
};

/** The Board's cadence; the backend fetches GitHub at most every 3 min. */
export const TARGET_SYNC_POLL_MS = 180_000;

const inFlight = new Map<string, Promise<void>>();

export const useTargetSync = create<TargetSyncStore>((set, get) => ({
  byWorkspace: {},
  pressing: {},

  refresh: (workspaceId, opened) => {
    const running = inFlight.get(workspaceId);
    if (running) return running;
    const run = (async () => {
      try {
        const report = await cardsTargetSync(workspaceId, opened);
        set((s) => ({ byWorkspace: { ...s.byWorkspace, [workspaceId]: report } }));
      } catch (e) {
        // A reading only: the badge stays as it was.
        console.warn("cards_target_sync failed", e);
      } finally {
        inFlight.delete(workspaceId);
      }
    })();
    inFlight.set(workspaceId, run);
    return run;
  },

  bringIn: async (workspaceId, cardId) => {
    if (get().pressing[cardId]) return;
    set((s) => ({ pressing: { ...s.pressing, [cardId]: true } }));
    try {
      const result = await cardBringInTarget(workspaceId, cardId);
      // Walk 8.3: the card's work changed; a merge's old refusal no longer
      // stops it (the conflict, if any, leads now).
      if (result.kind !== "up_to_date") cardWorkChanged(workspaceId, cardId);
      // F3 walk (review): what GitHub has may have changed: read the lands again.
      if (result.kind !== "up_to_date") forgetSentToGitHub(workspaceId);
      await useKanban.getState().loadFromDisk(workspaceId, true);
      const card = cardInWorkspace(useKanban.getState().byWorkspace, workspaceId, cardId) ?? result.card;
      const onAsk =
        result.recorded && card.builder && !card.archived
          ? () => void useBuilder.getState().resolveShipConflict(workspaceId, cardId)
          : null;
      pushToast(bringInToast(result, prOpen(card), onAsk));
    } catch (e) {
      const said = plainFailure(e);
      pushToast({ kind: "error", title: "Nothing was brought in", body: said.sentence, details: said.details || undefined });
    } finally {
      set((s) => {
        const pressing = { ...s.pressing };
        delete pressing[cardId];
        return { pressing };
      });
      await get().refresh(workspaceId, false);
    }
  },
}));
