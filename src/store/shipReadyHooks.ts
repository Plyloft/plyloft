import { useEffect, useMemo } from "react";
import { isShipBatchEligible } from "../lib/boardSemantics";
import { eligibleSignature, shipReady, shipReadyTotal, type ShipReady } from "../lib/shipReady";
import { onKanbanChanged } from "../ipc";
import { useKanban } from "./kanbanStore";
import { useShip } from "./shipStore";

/**
 * QoL 1.168 C7: the cards Ship batch would take, per workspace — the one
 * list the sidebar, ⌘K, a Board's header and the sheet read
 * (`lib/shipReady.ts`). Subscribes to the two stable store slices and
 * derives in a memo (PATTERNS: no fresh arrays from a selector).
 */
export function useShipReady(): ShipReady {
  const pending = useShip((s) => s.pending);
  const boards = useKanban((s) => s.byWorkspace);
  return useMemo(() => shipReady(pending, boards, isShipBatchEligible), [pending, boards]);
}

/** The total, with the older backend's count when no list came back. */
export function useShipReadyTotal(): number {
  const ready = useShipReady();
  const pending = useShip((s) => s.pending);
  const count = useShip((s) => s.pendingCount);
  return pending === null ? Math.max(count ?? 0, shipReadyTotal(ready)) : shipReadyTotal(ready);
}

/** The same total, read once outside React (the Quick tour's marks). */
export function shipReadyTotalNow(): number {
  const { pending, pendingCount } = useShip.getState();
  const ready = shipReadyTotal(shipReady(pending, useKanban.getState().byWorkspace, isShipBatchEligible));
  return pending === null ? Math.max(pendingCount ?? 0, ready) : ready;
}

/** Read the backend's list again shortly after a loaded Board's eligible
 *  cards change (a card that just became ready, or stopped being). Mounted
 *  once, with the sidebar's ship rows. */
export function useShipReadyRefresh(delayMs = 1500): void {
  const boards = useKanban((s) => s.byWorkspace);
  const signature = useMemo(() => eligibleSignature(boards, isShipBatchEligible), [boards]);
  useEffect(() => {
    const id = window.setTimeout(() => void useShip.getState().refreshPendingCount(), delayMs);
    return () => window.clearTimeout(id);
  }, [signature, delayMs]);
  // QoL 1.168 (lane 2 Mac walk): a card that becomes ready on disk on a
  // Board not loaded here never changes the signature above. Any board
  // change the backend announces (`kanban://changed`) and the window coming
  // back to the front read the list again too — debounced, one read per
  // burst.
  useEffect(() => {
    let timer: number | null = null;
    const soon = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        void useShip.getState().refreshPendingCount();
      }, delayMs);
    };
    let unlisten: (() => void) | null = null;
    let gone = false;
    onKanbanChanged(() => soon())
      .then((u) => {
        if (gone) u();
        else unlisten = u;
      })
      .catch(() => {});
    window.addEventListener("focus", soon);
    return () => {
      gone = true;
      unlisten?.();
      window.removeEventListener("focus", soon);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [delayMs]);
}
