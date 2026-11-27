import { create } from "zustand";
import {
  coordinationStatus,
  onCoordinationChanged,
  type WorkspaceCoordinationStatus,
} from "../ipc";

export const EMPTY_COORDINATION_STATUS: WorkspaceCoordinationStatus =
  Object.freeze({
    trackingActive: false,
    state: "loading",
    workspaceId: "",
    activeSessions: [],
    liveWarnings: [],
    recentInterruptedCount: 0,
  });

export interface WorkspaceCoordinationState {
  status: WorkspaceCoordinationStatus | null;
  loading: boolean;
  error: string | null;
}

const EMPTY_WORKSPACE_STATE: WorkspaceCoordinationState = Object.freeze({
  status: null,
  loading: false,
  error: null,
});

interface CoordinationStore {
  byWorkspace: Record<string, WorkspaceCoordinationState>;
  refresh: (workspaceId: string) => Promise<void>;
  remove: (workspaceId: string) => void;
}

export function coordinationWorkspaceState(
  state: CoordinationStore,
  workspaceId: string,
): WorkspaceCoordinationState {
  return state.byWorkspace[workspaceId] ?? EMPTY_WORKSPACE_STATE;
}

export const useCoordination = create<CoordinationStore>((set) => ({
  byWorkspace: {},

  refresh: async (workspaceId) => {
    set((state) => ({
      byWorkspace: {
        ...state.byWorkspace,
        [workspaceId]: {
          status: state.byWorkspace[workspaceId]?.status ?? null,
          loading: true,
          error: null,
        },
      },
    }));
    try {
      const status = await coordinationStatus(workspaceId);
      set((state) => ({
        byWorkspace: {
          ...state.byWorkspace,
          [workspaceId]: { status, loading: false, error: null },
        },
      }));
    } catch (error) {
      set((state) => ({
        byWorkspace: {
          ...state.byWorkspace,
          [workspaceId]: {
            status: state.byWorkspace[workspaceId]?.status ?? null,
            loading: false,
            error: String(error),
          },
        },
      }));
    }
  },

  remove: (workspaceId) => {
    set((state) => {
      if (!(workspaceId in state.byWorkspace)) return state;
      const byWorkspace = { ...state.byWorkspace };
      delete byWorkspace[workspaceId];
      return { byWorkspace };
    });
  },
}));

let subscriptionStarted = false;

export async function startCoordinationSubscription() {
  if (subscriptionStarted) return;
  subscriptionStarted = true;
  await onCoordinationChanged(({ workspaceId }) => {
    if (workspaceId) {
      void useCoordination.getState().refresh(workspaceId);
      return;
    }
    for (const loadedWorkspaceId of Object.keys(
      useCoordination.getState().byWorkspace,
    )) {
      void useCoordination.getState().refresh(loadedWorkspaceId);
    }
  });
}
