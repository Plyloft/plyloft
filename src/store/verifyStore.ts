import { create } from "zustand";
import {
  verifyStart,
  verifyStatus,
  verifyListInflight,
  onVerifyDone,
  onVerifyProgress,
  type VerifyJobStatus,
  type VerifyRequestPayload,
} from "../ipc";
import { useKanban } from "./kanbanStore";
import { useShip } from "./shipStore";

/**
 * v1.10.x (Phase B): UI mirror of the global verify queue. The backend
 * runs at most one verify pipeline at a time across all workspaces; this
 * store caches the most recent status per (workspace, card) so the
 * Verifying column + VerifyPanel render without polling per-cell.
 *
 * The store subscribes to `verify://progress` + `verify://done` events
 * once and re-pulls fresh status on every notification.
 */
interface VerifyStoreShape {
  /** Keyed by `${workspaceId}::${cardId}`. */
  byKey: Record<string, VerifyJobStatus>;
  /** All in-flight jobs (active + queued) for batch surfaces. */
  inflight: VerifyJobStatus[];

  start: (req: VerifyRequestPayload) => Promise<string>;
  refresh: (workspaceId: string, cardId: string) => Promise<void>;
  refreshInflight: () => Promise<void>;
  /** One-time bootstrap: subscribe to verify events. Idempotent. */
  bootstrapListeners: () => Promise<void>;
}

let listenersBootstrapped = false;

function key(workspaceId: string, cardId: string): string {
  return `${workspaceId}::${cardId}`;
}

export const useVerify = create<VerifyStoreShape>((set, get) => ({
  byKey: {},
  inflight: [],

  start: async (req) => {
    const id = await verifyStart(req);
    // Re-fetch status so the row flips to Queued/Running immediately.
    await get().refresh(req.workspaceId, req.cardId);
    await get().refreshInflight();
    return id;
  },

  refresh: async (workspaceId, cardId) => {
    try {
      const status = await verifyStatus(workspaceId, cardId);
      if (!status) return;
      set((s) => ({
        byKey: { ...s.byKey, [key(workspaceId, cardId)]: status },
      }));
    } catch (e) {
      console.error("verify status fetch failed", e);
    }
  },

  refreshInflight: async () => {
    try {
      const list = await verifyListInflight();
      set({ inflight: list });
    } catch (e) {
      console.error("verify inflight fetch failed", e);
    }
  },

  bootstrapListeners: async () => {
    if (listenersBootstrapped) return;
    listenersBootstrapped = true;
    // We don't yet correlate runIds back to (workspace, card) on the
    // frontend — the simplest cure is to refresh the inflight list +
    // active job status on every event. Cheap and idempotent.
    await onVerifyProgress(async () => {
      await get().refreshInflight();
      const inflight = get().inflight;
      for (const job of inflight) {
        if (job.state.kind === "running" || job.state.kind === "queued") {
          await get().refresh(job.workspaceId, job.cardId);
        }
      }
    });
    await onVerifyDone(async () => {
      await get().refreshInflight();
      // After done, re-pull every job we have cached so terminal
      // states (passed / failed / timedOut) land in `byKey`.
      const cached = Object.values(get().byKey);
      for (const job of cached) {
        await get().refresh(job.workspaceId, job.cardId);
      }
      // v1.9.1 (Bug B): force-reload the kanban for every workspace
      // touched by the verify queue so card.verifyStatus / .verifyHistory
      // reflect what the backend just persisted. Without this, the FE
      // cache stays at the pre-verify state and a subsequent
      // updateCard() (e.g., after Ship now) would clobber the verify
      // update on disk.
      const wsIds = new Set(cached.map((j) => j.workspaceId));
      for (const wsId of wsIds) {
        await useKanban.getState().loadFromDisk(wsId, true);
      }
      // A passing verify flips a card to `verifyStatus: passed`, which is
      // the gate for `Ship batch (N)` toolbar visibility. Refresh the
      // ship store's pending count so the button appears without
      // requiring a fresh AppToolbar mount.
      await useShip.getState().refreshPendingCount();
      await useShip.getState().refreshUnverifiedCount();
    });
  },
}));
