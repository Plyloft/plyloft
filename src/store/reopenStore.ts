import { create } from "zustand";
import { terminalReopenDismiss, terminalReopenOffers, type TerminalSession } from "../ipc";
import { useTiles } from "./tileStore";

/**
 * QoL 1.168 (block 4, D5, owner D11): what each workspace's Terminals offers
 * to reopen after a relaunch — the Claude and Codex sessions open when
 * Plyloft last quit (`terminal_reopen_offers`), read once at launch. Put
 * away (taken, or "Not now") it is gone for good: the record is cleared too
 * (`terminal_reopen_dismiss`). In memory; the record is the backend's.
 *
 * F3 (1.172.1, owner 2026-10-28): offered only until you open or start a
 * session in that workspace (a new tile, Resume…, a Restart, a card's
 * session that shows as a tile there). Then it puts itself away the same
 * way, without a word; History › Sessions still has each, with Resume.
 */
interface ReopenState {
  byWorkspace: Record<string, TerminalSession[]>;
  /** When this launch began offering: a tile started at or after it is you
   *  working. Null until `startReopenOffers` (tests set it). */
  since: number | null;
}

export const useReopen = create<ReopenState>(() => ({ byWorkspace: {}, since: null }));

let started = false;

/** App start: read the offers once. */
export function startReopenOffers(): void {
  if (started) return;
  started = true;
  useReopen.setState({ since: Date.now() });
  void terminalReopenOffers()
    .then((all) => {
      if (all && typeof all === "object") {
        useReopen.setState({ byWorkspace: all });
        // A session opened while the offers were being read counts too.
        putAwayOnceWorking();
      }
    })
    .catch(() => {});
}

/** The workspace's offer is put away, here and in the record. */
export function dismissReopen(workspaceId: string): void {
  const { byWorkspace } = useReopen.getState();
  if (byWorkspace[workspaceId]) {
    const next = { ...byWorkspace };
    delete next[workspaceId];
    useReopen.setState({ byWorkspace: next });
  }
  void terminalReopenDismiss(workspaceId).catch(() => {});
}

type TilesState = ReturnType<typeof useTiles.getState>;

/** F3: a workspace with an offer where a session was opened or started since
 *  the offer began puts it away — that workspace's only. */
export function putAwayOnceWorking(tiles: Pick<TilesState, "byWorkspace"> = useTiles.getState()): void {
  const { byWorkspace, since } = useReopen.getState();
  // The hot path: every tile change lands here, and usually nothing is offered.
  if (since == null || Object.keys(byWorkspace).length === 0) return;
  for (const workspaceId of Object.keys(byWorkspace)) {
    if (tiles.byWorkspace[workspaceId]?.tiles.some((t) => t.startedAt >= since)) dismissReopen(workspaceId);
  }
}

useTiles.subscribe((s, prev) => {
  if (s.byWorkspace !== prev.byWorkspace) putAwayOnceWorking(s);
});

/** Tests: start again. */
export function resetReopenForTests(): void {
  started = false;
  useReopen.setState({ byWorkspace: {}, since: null });
}
