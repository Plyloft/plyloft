// 1.173.0 (B2): each workspace's areas (B1's `areasGet`), the area it is on
// in this session, and the two-products discovery (`areasDiscover`).
//
// The current area is per workspace, for the session, and starts at this
// Mac's default (`Workspace.defaultArea`). It is read through
// `currentAreaFor(workspaceId)` (the Board, new cards — B3's
// `lib/cardArea.ts` — and new copies) and `useCurrentArea` in components.
// The areas are read again whenever the workspace's shared definition is
// refreshed or edited.
import { useEffect } from "react";
import { create } from "zustand";
import {
  areasDiscover,
  areasGet,
  onWorkspaceDefinitionEdited,
  onWorkspaceDefinitionRefreshed,
  type AreaDef,
  type AreaDiscovery,
  type AreasView,
  type ResolvedArea,
} from "../ipc";
import { areaById, copyBranch, currentAreaId } from "../lib/areaPicker";
import { AREAS_SETTINGS_SECTION, provideCurrentArea } from "../lib/cardArea";
import { useWorkspaces } from "./workspaceStore";
import { useUi } from "./uiStore";

type AreaState = {
  /** The last `areasGet` answer per workspace; absent until read. */
  views: Record<string, AreasView | undefined>;
  /** The last `areasGet` failed (its error), per workspace; cleared when a
   *  read starts again or lands. */
  failed: Record<string, unknown>;
  /** The last `areasDiscover` answer; `null` = fewer than two products. */
  discoveries: Record<string, AreaDiscovery | null | undefined>;
  /** The area chosen in this session (`null` = All areas); absent = this
   *  Mac's default. */
  chosen: Record<string, string | null | undefined>;
  /** *Set up areas…*'s suggestion, for Settings › Areas (B5) to take. */
  suggestion: Record<string, AreaDef[] | undefined>;
  load: (workspaceId: string) => Promise<void>;
  discover: (workspaceId: string) => Promise<void>;
  choose: (workspaceId: string, areaId: string | null) => void;
  offerSuggestion: (workspaceId: string, areas: AreaDef[]) => void;
  /** B5: the suggestion *Set up areas…* left, once (it is cleared). */
  takeSuggestion: (workspaceId: string) => AreaDef[] | null;
};

/** Only the newest read of a workspace lands. */
const tickets = new Map<string, number>();
const discoverTickets = new Map<string, number>();
/** First reads on their way: the Board, the picker and the notice ask at
 *  once, and one read answers all three. */
const firstReads = new Set<string>();
const firstLooks = new Set<string>();

function readOnce(workspaceId: string) {
  const s = useAreas.getState();
  if (s.views[workspaceId] !== undefined || firstReads.has(workspaceId)) return;
  firstReads.add(workspaceId);
  void s.load(workspaceId).finally(() => firstReads.delete(workspaceId));
}

function lookOnce(workspaceId: string) {
  const s = useAreas.getState();
  if (s.discoveries[workspaceId] !== undefined || firstLooks.has(workspaceId)) return;
  firstLooks.add(workspaceId);
  void s.discover(workspaceId).finally(() => firstLooks.delete(workspaceId));
}

export const useAreas = create<AreaState>((set, get) => ({
  views: {},
  failed: {},
  discoveries: {},
  chosen: {},
  suggestion: {},

  load: async (workspaceId) => {
    const ticket = (tickets.get(workspaceId) ?? 0) + 1;
    tickets.set(workspaceId, ticket);
    if (workspaceId in get().failed) set((s) => ({ failed: withoutKey(s.failed, workspaceId) }));
    try {
      const view = await areasGet(workspaceId);
      if (tickets.get(workspaceId) !== ticket) return;
      set((s) => ({ views: { ...s.views, [workspaceId]: view }, failed: withoutKey(s.failed, workspaceId) }));
    } catch (e) {
      console.warn("areas_get failed:", e);
      if (tickets.get(workspaceId) !== ticket) return;
      set((s) => ({ failed: { ...s.failed, [workspaceId]: e ?? "areas_get failed" } }));
    }
  },

  discover: async (workspaceId) => {
    const ticket = (discoverTickets.get(workspaceId) ?? 0) + 1;
    discoverTickets.set(workspaceId, ticket);
    try {
      const found = await areasDiscover(workspaceId);
      if (discoverTickets.get(workspaceId) !== ticket) return;
      set((s) => ({ discoveries: { ...s.discoveries, [workspaceId]: found } }));
    } catch (e) {
      console.warn("areas_discover failed:", e);
    }
  },

  choose: (workspaceId, areaId) => set((s) => ({ chosen: { ...s.chosen, [workspaceId]: areaId } })),

  offerSuggestion: (workspaceId, areas) =>
    set((s) => ({ suggestion: { ...s.suggestion, [workspaceId]: areas } })),

  takeSuggestion: (workspaceId) => {
    const found = get().suggestion[workspaceId] ?? null;
    if (found) {
      set((s) => {
        const next = { ...s.suggestion };
        delete next[workspaceId];
        return { suggestion: next };
      });
    }
    return found;
  },
}));

let listening = false;
let unlisteners: Promise<() => void>[] = [];

/** Tests: the next stub gets its own listeners. */
export function resetAreaListenersForTests() {
  for (const off of unlisteners) void off.then((f) => f()).catch(() => {});
  unlisteners = [];
  listening = false;
  firstReads.clear();
  firstLooks.clear();
}

/** Read a workspace's areas again when its shared definition changes. */
function listenOnce() {
  if (listening) return;
  listening = true;
  const again = (workspaceId: string) => {
    const s = useAreas.getState();
    if (s.views[workspaceId] !== undefined) void s.load(workspaceId);
    if (s.discoveries[workspaceId] !== undefined) void s.discover(workspaceId);
  };
  const refreshed = onWorkspaceDefinitionRefreshed((report) => again(report.workspaceId));
  const edited = onWorkspaceDefinitionEdited(again);
  unlisteners = [refreshed, edited];
  void Promise.all(unlisteners).catch(() => {
    listening = false;
  });
}

function defaultAreaOf(workspaceId: string): string | null {
  return useWorkspaces.getState().workspaces.find((w) => w.id === workspaceId)?.defaultArea ?? null;
}

/**
 * The area a workspace is on (`null` = All areas): the session's choice,
 * else this Mac's default — only while the picker shows (two areas or more,
 * none held). New cards take it (B3), the Board filters by it.
 */
export function currentAreaFor(workspaceId: string): string | null {
  const s = useAreas.getState();
  return currentAreaId(s.views[workspaceId], s.chosen[workspaceId], defaultAreaOf(workspaceId));
}

/** Where a new copy of the workspace starts: its current area's branch
 *  (one area: its branch), else `null` — the workspace's target. */
export function copyBranchFor(workspaceId: string): string | null {
  return copyBranch(useAreas.getState().views[workspaceId], currentAreaFor(workspaceId));
}

/** The workspace's areas, read on first use and again when its shared
 *  definition changes. `undefined` until read. */
export function useAreasView(workspaceId: string | null): AreasView | undefined {
  const view = useAreas((s) => (workspaceId ? s.views[workspaceId] : undefined));
  useEffect(() => {
    if (!workspaceId) return;
    listenOnce();
    readOnce(workspaceId);
  }, [workspaceId]);
  return view;
}

/** Whether the workspace's last areas read failed, and with what (C10
 *  round 3): `undefined` while none failed. */
export function useAreasFailure(workspaceId: string | null): unknown {
  return useAreas((s) => (workspaceId ? s.failed[workspaceId] : undefined));
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

/** The two-products discovery, looked for on first use. */
export function useAreaDiscovery(workspaceId: string, wanted: boolean): AreaDiscovery | null | undefined {
  const found = useAreas((s) => s.discoveries[workspaceId]);
  useEffect(() => {
    if (!wanted) return;
    listenOnce();
    lookOnce(workspaceId);
  }, [workspaceId, wanted]);
  return found;
}

/** The area the workspace is on, resolved (`null` = All areas). */
export function useCurrentArea(workspaceId: string | null): ResolvedArea | null {
  const view = useAreasView(workspaceId);
  const chosen = useAreas((s) => (workspaceId ? s.chosen[workspaceId] : undefined));
  const defaultArea = useWorkspaces((s) =>
    workspaceId ? (s.workspaces.find((w) => w.id === workspaceId)?.defaultArea ?? null) : null,
  );
  return areaById(view, currentAreaId(view, chosen, defaultArea));
}

// B2–B3 join: new cards (`lib/cardArea.ts`, `kanbanStore.addCard`) are
// made in this store's current area.
provideCurrentArea(currentAreaFor);

/** *Edit areas…* and *Set up areas…* (with Plyloft's suggestion, which
 *  Settings › Areas takes with `takeSuggestion`). */
export function openAreasSettings(workspaceId: string, suggestion?: AreaDef[]) {
  if (suggestion) useAreas.getState().offerSuggestion(workspaceId, suggestion);
  useUi.getState().openSettingsSection(AREAS_SETTINGS_SECTION, { workspaceId });
}

/** Read the areas of these workspaces (the Inbox's rows), once each. */
export function ensureAreasRead(workspaceIds: readonly string[]) {
  listenOnce();
  for (const id of new Set(workspaceIds)) readOnce(id);
}
