import { create } from "zustand";
import {
  shipAudit,
  shipCard,
  shipPendingCards,
  shipPendingCount,
  shipUnverifiedCount,
  drainStart,
  drainCancel,
  drainStatus,
  type AuditFor,
  type ShipAuditReport,
  type ShipRequest,
  type ShipResult,
  type DrainStatus,
  type PendingShipCards,
} from "../ipc";

/** v1.9.x (Phase A.5): drain hard timeout matches the plan's 30-min cap. */
const DRAIN_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * v1.9.0 (Phase A): UI-side coordination state for the ship pipeline.
 *
 * Phase A's surface is small: a pending-count badge, a Ship now button on
 * verified cards, and the pre-ship audit modal. The store doesn't cache
 * audit results — the modal always re-fetches so the user sees the
 * current in-flight state at the moment they click Ship.
 */
interface ShipState {
  /** Cached pending-card count for the toolbar badge. Refreshed when
   *  the kanban store mutates a card's ship/verify state. Null = not
   *  yet fetched. */
  pendingCount: number | null;
  /** QoL 1.168 C7: the cards a batch can ship, per workspace on disk — the
   *  one source of every "Ship N" (`lib/shipReady.ts`, `useShipReady`).
   *  Null until read (or from an older backend: then only the count). */
  pending: PendingShipCards[] | null;
  /** 1.173.0 (F2): the last read of `pending` failed (or the backend has no
   *  list) — `pending` is null not because it is still being read. Cleared
   *  by the next read that succeeds. */
  pendingFailed: boolean;
  /** v1.13.x (Phase E): cached count of cards whose latest ship was
   *  skip-verify. Drives the red `unverified` toolbar badge. */
  unverifiedCount: number | null;
  /** Most recent audit (null until first call). The audit modal sets
   *  this so consumers in the modal don't re-fetch. */
  lastAudit: ShipAuditReport | null;
  /** True while a ship_card invocation is in flight client-side. The
   *  backend has its own concurrent-ship lock; this mirrors it for
   *  immediate UI feedback. */
  shipping: boolean;
  /** Mirror of the backend drain coordinator. Polled by the AppToolbar
   *  drain banner; updated by `drainBegin` / `drainEnd`. */
  drain: DrainStatus;

  refreshPendingCount: () => Promise<void>;
  refreshUnverifiedCount: () => Promise<void>;
  /** 1.173.0 (B4): `asked` names the card (its area) or the area. */
  refreshAudit: (workspaceId?: string, asked?: AuditFor) => Promise<ShipAuditReport>;
  performShip: (req: ShipRequest) => Promise<ShipResult>;
  /** Phase A.5: enter drain mode. Backend rejects new dispatches; the
   *  audit modal monitors counts via polling. */
  drainBegin: () => Promise<void>;
  /** Phase A.5: cancel drain mode without shipping. */
  drainEnd: () => Promise<void>;
  /** Phase A.5: refresh drain status from the backend (called by the
   *  toolbar polling loop). */
  refreshDrain: () => Promise<DrainStatus>;
  /** Computed: drain has run past its hard timeout. */
  drainTimedOut: () => boolean;
}

export const useShip = create<ShipState>((set, get) => ({
  pendingCount: null,
  pending: null,
  pendingFailed: false,
  unverifiedCount: null,
  lastAudit: null,
  shipping: false,
  drain: { draining: false, startedAt: null },

  refreshPendingCount: async () => {
    try {
      const list = await shipPendingCards();
      if (Array.isArray(list)) {
        set({
          pending: list,
          pendingFailed: false,
          pendingCount: list.reduce((n, w) => n + w.cardIds.length, 0),
        });
        return;
      }
    } catch (e) {
      console.error("ship: pending cards fetch failed", e);
    }
    set({ pendingFailed: true });
    try {
      const n = await shipPendingCount();
      set({ pendingCount: n });
    } catch (e) {
      console.error("ship: pending count fetch failed", e);
    }
  },

  refreshUnverifiedCount: async () => {
    try {
      const n = await shipUnverifiedCount();
      set({ unverifiedCount: n });
    } catch (e) {
      console.error("ship: unverified count fetch failed", e);
    }
  },

  refreshAudit: async (workspaceId, asked) => {
    const report = await shipAudit(workspaceId, asked);
    set({ lastAudit: report });
    return report;
  },

  performShip: async (req) => {
    if (get().shipping) {
      throw new Error("ship already in progress");
    }
    set({ shipping: true });
    try {
      const result = await shipCard(req);
      await get().refreshPendingCount();
      await get().refreshUnverifiedCount();
      return result;
    } finally {
      set({ shipping: false });
    }
  },

  drainBegin: async () => {
    await drainStart();
    const status = await drainStatus();
    set({ drain: status });
  },

  drainEnd: async () => {
    await drainCancel();
    set({ drain: { draining: false, startedAt: null } });
  },

  refreshDrain: async () => {
    const status = await drainStatus();
    set({ drain: status });
    return status;
  },

  drainTimedOut: () => {
    const { draining, startedAt } = get().drain;
    if (!draining || startedAt === null) return false;
    return Date.now() - startedAt > DRAIN_TIMEOUT_MS;
  },
}));
