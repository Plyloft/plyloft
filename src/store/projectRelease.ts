// 1.173.0 (F2): Release… from the project — the inputs every Release… reads
// (this workspace's ready cards and B4's groups of them). 1.174.0 (DR3):
// every press opens the one Release sheet (`ReleaseSheet`).
import { useEffect, useMemo } from "react";
import type { KanbanCard } from "../ipc";
import { allAreasReleaseCards, releaseTarget, type ReleaseInputs } from "../lib/projectRelease";
import { pickerAreas } from "../lib/areaPicker";
import { useAreasView, useCurrentArea } from "./areaStore";
import { useScopesReading } from "./releaseScopeStore";
import { useKanban } from "./kanbanStore";
import { useShip } from "./shipStore";
import { useShipReady } from "./shipReadyHooks";
import { useUi, type ReleaseSheetAsk } from "./uiStore";

const NO_IDS: readonly string[] = [];
const NO_CARDS: readonly KanbanCard[] = [];

/** This workspace's ready cards, their area groups (the sidebar's list,
 *  kept fresh by `useShipReadyRefresh`) and its Board's cards. `readAgain`:
 *  read it once more on open — a page, never every Board (each warmed
 *  workspace mounts one, and the list asks git about every workspace).
 *  Until the list is read, `reading`: Release… is off, saying nothing yet;
 *  when it can't be read, `failed`. */
export function useReleaseInputs(workspaceId: string, readAgain = false): ReleaseInputs {
  const ready = useShipReady();
  const pending = useShip((s) => s.pending);
  const pendingFailed = useShip((s) => s.pendingFailed);
  const cards = useKanban((s) => s.byWorkspace[workspaceId]?.cards ?? NO_CARDS);
  useEffect(() => {
    if (readAgain) void useShip.getState().refreshPendingCount();
  }, [workspaceId, readAgain]);
  return useMemo(
    () => ({
      entry: pending?.find((p) => p.workspaceId === workspaceId),
      readyIds: ready[workspaceId] ?? NO_IDS,
      cards,
      // A failed read is not "reading" for good: the Board's own ready
      // cards stand in (`useShipReady` falls back to them).
      reading: pending === null && !pendingFailed,
      failed: pending === null && pendingFailed,
    }),
    [pending, pendingFailed, workspaceId, ready, cards],
  );
}

/** 1.174.0 (DR3): open the one Release sheet. Every Release… comes here:
 *  the Board's ⋯ and header, the sidebar's Release N…, ⌘K, a card's ⋯ ›
 *  Release…, How this goes live. On every plan: releasing what is on the
 *  branch already is free. */
export function openRelease(ask: ReleaseSheetAsk): void {
  useUi.getState().setReleaseSheet({ ...ask, ...(ask.cardIds ? { cardIds: [...ask.cardIds] } : {}) });
}

/** 1.174.0 (DR5 → DR3): How this goes live's Show it — the area's release
 *  on its way, in the Release sheet. */
export function showRelease(workspaceId: string, areaId?: string | null): void {
  openRelease(areaId === undefined ? { workspaceId } : { workspaceId, areaId });
}

/** Release these ready cards of one workspace (an area's, or the
 *  project's): the Release sheet, with them ticked. */
export function releaseCards(workspaceId: string, cardIds: readonly string[], areaId?: string | null): void {
  openRelease(areaId === undefined ? { workspaceId, cardIds } : { workspaceId, areaId, cardIds });
}

/** 1.174.1 P3 (T3): what the Board header's "Release N cards…" — and the
 *  sidebar's, for the active project — takes and opens. On an area, its
 *  ready cards; on All areas of a project with two or more areas, the ready
 *  cards of the one area the sheet will open (`allAreasReleaseCards`), and
 *  the sheet decides or asks (`asks`); else every ready card. */
export interface HeaderRelease {
  cardIds: readonly string[];
  /** The area it opens on (the current one), or undefined. */
  areaId: string | null | undefined;
  /** All areas of a project with areas: the sheet opens the area with
   *  something, or asks which. */
  asks: boolean;
}

export function useHeaderRelease(workspaceId: string | null): HeaderRelease {
  const id = workspaceId ?? "";
  const inputs = useReleaseInputs(id);
  const view = useAreasView(workspaceId);
  const area = useCurrentArea(workspaceId);
  const reading = useScopesReading(workspaceId);
  return useMemo(() => {
    if (!workspaceId) return { cardIds: NO_IDS, areaId: undefined, asks: false };
    if (area) {
      const target = releaseTarget(inputs, { id: area.id, name: area.name });
      return { cardIds: target.cardIds, areaId: target.areaId, asks: false };
    }
    const order = pickerAreas(view).map((a) => a.id);
    if (order.length >= 2) {
      return { cardIds: allAreasReleaseCards(inputs, order, reading.scopes), areaId: undefined, asks: true };
    }
    return { cardIds: inputs.readyIds, areaId: undefined, asks: false };
  }, [workspaceId, inputs, view, area, reading.scopes]);
}

/** The header's (and the sidebar's) press: the Release sheet as it counted. */
export function openHeaderRelease(workspaceId: string, release: HeaderRelease): void {
  if (release.areaId !== undefined) releaseCards(workspaceId, release.cardIds, release.areaId);
  else if (release.asks) openRelease({ workspaceId });
  else releaseCards(workspaceId, release.cardIds);
}
