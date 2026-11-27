import { create } from "zustand";
import {
  memoryCreate,
  memoryDelete,
  memoryList,
  memoryUpdate,
  type Memory,
  type MemoryCreateInput,
  type MemoryPatch,
  type MemoryScope,
} from "../ipc";

/** v1.35.0: per-workspace + opt-in global memory store. Mirrors the
 *  per-workspace pattern used by kanban/agents/editor stores. Global
 *  memories live in a flat slice (not keyed by workspace).
 *
 *  Selector rule (per docs/PATTERNS.md): consumers that may receive
 *  an `undefined` slice — e.g. when a workspace's memories haven't
 *  been loaded yet — must select via the helpers below, which return
 *  the module-scoped EMPTY constants. Returning `[]` inline from a
 *  selector creates a fresh array on every render and breaks zustand's
 *  identity check, forcing infinite re-renders. */
const EMPTY_MEMORIES: Memory[] = [];

type SliceState = {
  items: Memory[];
  loaded: boolean;
  loading: boolean;
  error: string | null;
};

const EMPTY_SLICE: SliceState = {
  items: EMPTY_MEMORIES,
  loaded: false,
  loading: false,
  error: null,
};

type MemoryStoreState = {
  byWorkspace: Record<string, SliceState>;
  global: SliceState;

  /** Load (or re-load) memories for a scope. No-op for an already-
   *  loaded workspace unless `force` is true. */
  refresh: (scope: MemoryScope, workspaceId: string | null, force?: boolean) => Promise<void>;
  create: (input: MemoryCreateInput) => Promise<Memory>;
  update: (
    scope: MemoryScope,
    workspaceId: string | null,
    id: string,
    patch: MemoryPatch,
  ) => Promise<Memory>;
  remove: (
    scope: MemoryScope,
    workspaceId: string | null,
    id: string,
  ) => Promise<void>;
};

function sliceKey(scope: MemoryScope, workspaceId: string | null): string {
  return scope === "global" ? "__global__" : `ws:${workspaceId}`;
}

export const useMemory = create<MemoryStoreState>((set, get) => ({
  byWorkspace: {},
  global: EMPTY_SLICE,

  refresh: async (scope, workspaceId, force = false) => {
    if (scope === "workspace" && (!workspaceId || workspaceId.length === 0)) {
      // Cannot load workspace scope without an id — silently no-op so
      // a transient mount with `activeWorkspaceId === null` doesn't
      // throw. The caller is expected to re-invoke once the id arrives.
      return;
    }
    const current =
      scope === "global"
        ? get().global
        : get().byWorkspace[workspaceId as string] ?? EMPTY_SLICE;
    if (current.loaded && !force) return;
    if (current.loading) return;
    // Mark loading.
    if (scope === "global") {
      set({ global: { ...current, loading: true, error: null } });
    } else {
      set({
        byWorkspace: {
          ...get().byWorkspace,
          [workspaceId as string]: { ...current, loading: true, error: null },
        },
      });
    }
    try {
      const items = await memoryList(scope, workspaceId);
      const next: SliceState = {
        items,
        loaded: true,
        loading: false,
        error: null,
      };
      if (scope === "global") {
        set({ global: next });
      } else {
        set({
          byWorkspace: {
            ...get().byWorkspace,
            [workspaceId as string]: next,
          },
        });
      }
    } catch (e) {
      const errSlice: SliceState = {
        ...current,
        loading: false,
        error: String(e),
      };
      if (scope === "global") {
        set({ global: errSlice });
      } else {
        set({
          byWorkspace: {
            ...get().byWorkspace,
            [workspaceId as string]: errSlice,
          },
        });
      }
    }
  },

  create: async (input) => {
    const saved = await memoryCreate(input);
    insertIntoSlice(saved, set, get);
    return saved;
  },

  update: async (scope, workspaceId, id, patch) => {
    const saved = await memoryUpdate(scope, workspaceId, id, patch);
    upsertIntoSlice(saved, set, get);
    return saved;
  },

  remove: async (scope, workspaceId, id) => {
    await memoryDelete(scope, workspaceId, id);
    removeFromSlice(scope, workspaceId, id, set, get);
  },
}));

function insertIntoSlice(
  m: Memory,
  set: (partial: Partial<MemoryStoreState>) => void,
  get: () => MemoryStoreState,
) {
  if (m.scope === "global") {
    const current = get().global;
    set({
      global: {
        ...current,
        items: prependById(current.items, m),
        loaded: true,
      },
    });
  } else if (m.workspaceId) {
    const key = m.workspaceId;
    const current = get().byWorkspace[key] ?? EMPTY_SLICE;
    set({
      byWorkspace: {
        ...get().byWorkspace,
        [key]: {
          ...current,
          items: prependById(current.items, m),
          loaded: true,
        },
      },
    });
  }
}

function upsertIntoSlice(
  m: Memory,
  set: (partial: Partial<MemoryStoreState>) => void,
  get: () => MemoryStoreState,
) {
  if (m.scope === "global") {
    const current = get().global;
    set({
      global: {
        ...current,
        items: replaceById(current.items, m),
      },
    });
  } else if (m.workspaceId) {
    const key = m.workspaceId;
    const current = get().byWorkspace[key] ?? EMPTY_SLICE;
    set({
      byWorkspace: {
        ...get().byWorkspace,
        [key]: {
          ...current,
          items: replaceById(current.items, m),
        },
      },
    });
  }
}

function removeFromSlice(
  scope: MemoryScope,
  workspaceId: string | null,
  id: string,
  set: (partial: Partial<MemoryStoreState>) => void,
  get: () => MemoryStoreState,
) {
  if (scope === "global") {
    const current = get().global;
    set({
      global: { ...current, items: current.items.filter((m) => m.id !== id) },
    });
  } else if (workspaceId) {
    const current = get().byWorkspace[workspaceId] ?? EMPTY_SLICE;
    set({
      byWorkspace: {
        ...get().byWorkspace,
        [workspaceId]: {
          ...current,
          items: current.items.filter((m) => m.id !== id),
        },
      },
    });
  }
}

function prependById(items: Memory[], m: Memory): Memory[] {
  // De-dupe by id then unshift — `create` always produces a new id but
  // a misfire from `upsertIntoSlice` reaching this path would otherwise
  // duplicate.
  return [m, ...items.filter((existing) => existing.id !== m.id)];
}

function replaceById(items: Memory[], m: Memory): Memory[] {
  return items.map((existing) => (existing.id === m.id ? m : existing));
}

/** Selector helpers — see EMPTY_MEMORIES comment for why these exist.
 *  Use these inside selectors, not inline `?? []`. */
export function selectWorkspaceMemories(
  state: MemoryStoreState,
  workspaceId: string,
): Memory[] {
  return state.byWorkspace[workspaceId]?.items ?? EMPTY_MEMORIES;
}

export function selectGlobalMemories(state: MemoryStoreState): Memory[] {
  return state.global.items;
}

export function selectWorkspaceSlice(
  state: MemoryStoreState,
  workspaceId: string,
): SliceState {
  return state.byWorkspace[workspaceId] ?? EMPTY_SLICE;
}

export { sliceKey };
