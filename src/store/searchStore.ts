import { create } from "zustand";

export type SearchStatus =
  | "idle"
  | "running"
  | "done"
  | "cancelled"
  | "capped"
  | "noRipgrep"
  | "error";

export interface SearchMatch {
  workspaceId: string;
  path: string;
  lineNumber: number;
  lineText: string;
  matchText: string;
  columnStart: number;
  columnEnd: number;
}

export interface SearchOptionsUI {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  includeHidden: boolean;
  glob: string;
}

export const DEFAULT_SEARCH_OPTIONS: SearchOptionsUI = {
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  includeHidden: false,
  glob: "",
};

interface WorkspaceSearch {
  query: string;
  options: SearchOptionsUI;
  results: SearchMatch[];
  status: SearchStatus;
  message?: string;
}

const emptySlice = (): WorkspaceSearch => ({
  query: "",
  options: { ...DEFAULT_SEARCH_OPTIONS },
  results: [],
  status: "idle",
});

interface SearchStore {
  byWorkspace: Record<string, WorkspaceSearch>;
  setQuery: (wsId: string, query: string) => void;
  setOptions: (wsId: string, opts: Partial<SearchOptionsUI>) => void;
  start: (wsId: string) => void;
  appendMatch: (m: SearchMatch) => void;
  finish: (
    wsId: string,
    status: SearchStatus,
    message: string | undefined,
  ) => void;
  reset: (wsId: string) => void;
}

export const useSearch = create<SearchStore>((set) => ({
  byWorkspace: {},
  setQuery: (wsId, query) =>
    set((state) => ({
      byWorkspace: {
        ...state.byWorkspace,
        [wsId]: { ...(state.byWorkspace[wsId] ?? emptySlice()), query },
      },
    })),
  setOptions: (wsId, opts) =>
    set((state) => {
      const slice = state.byWorkspace[wsId] ?? emptySlice();
      return {
        byWorkspace: {
          ...state.byWorkspace,
          [wsId]: { ...slice, options: { ...slice.options, ...opts } },
        },
      };
    }),
  start: (wsId) =>
    set((state) => {
      const slice = state.byWorkspace[wsId] ?? emptySlice();
      return {
        byWorkspace: {
          ...state.byWorkspace,
          [wsId]: { ...slice, results: [], status: "running", message: undefined },
        },
      };
    }),
  appendMatch: (m) =>
    set((state) => {
      const slice = state.byWorkspace[m.workspaceId] ?? emptySlice();
      if (slice.status !== "running") return state;
      return {
        byWorkspace: {
          ...state.byWorkspace,
          [m.workspaceId]: { ...slice, results: [...slice.results, m] },
        },
      };
    }),
  finish: (wsId, status, message) =>
    set((state) => {
      const slice = state.byWorkspace[wsId] ?? emptySlice();
      return {
        byWorkspace: {
          ...state.byWorkspace,
          [wsId]: { ...slice, status, message },
        },
      };
    }),
  reset: (wsId) =>
    set((state) => {
      const next = { ...state.byWorkspace };
      delete next[wsId];
      return { byWorkspace: next };
    }),
}));
