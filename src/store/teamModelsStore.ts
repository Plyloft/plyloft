import { useEffect } from "react";
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import {
  onWorkspaceDefinitionEdited,
  onWorkspaceDefinitionRefreshed,
  workspaceDefinitionSave,
} from "../ipc";
import type { RoleModels } from "../lib/roleModels";

/**
 * 1.169.0 (A2): the models and efforts the team suggests for a workspace —
 * `.atelier/workspace.json` → `models` — read with `team_models_get` from the
 * same store a spawn reads (`team_models.json`, kept in step by every
 * definition refresh), so a chip and a spawn always agree. Read again
 * whenever a refresh or an edit says the definition moved. A change is
 * published through the definition's queue (`workspace_definition_save`).
 */

export interface TeamModelsState {
  /** The workspace has a shared definition (the team can suggest). */
  shared: boolean;
  /** This Mac can't push the definition: the suggestions are read-only. */
  readOnly: boolean;
  /** As stored, unknown keys included (they travel back on an edit). */
  models: RoleModels | null;
}

const NONE: TeamModelsState = { shared: false, readOnly: false, models: null };

interface Store {
  byWorkspace: Record<string, TeamModelsState>;
  load: (workspaceId: string) => Promise<void>;
  /** Publish a change of the suggestions through the definition's queue.
   *  1.169.0 walk: edits run one at a time, each built on the value the one
   *  before it left (`change` gets the latest), so two quick edits never
   *  undo each other. */
  save: (workspaceId: string, change: (current: RoleModels | null) => RoleModels | null) => Promise<void>;
}

function readable(v: unknown): v is TeamModelsState {
  return !!v && typeof (v as TeamModelsState).shared === "boolean";
}

let listening = false;
/** One edit at a time per workspace. */
const saving = new Map<string, Promise<void>>();

export const useTeamModelsStore = create<Store>((set, get) => ({
  byWorkspace: {},
  load: async (workspaceId) => {
    if (!listening) {
      listening = true;
      const again = (id: string) => {
        if (get().byWorkspace[id]) void get().load(id);
      };
      void onWorkspaceDefinitionRefreshed((r) => again(r.workspaceId)).catch(() => {});
      void onWorkspaceDefinitionEdited(again).catch(() => {});
    }
    try {
      const view = await invoke<TeamModelsState>("team_models_get", { workspaceId });
      const next = readable(view) ? { shared: view.shared, readOnly: view.readOnly, models: view.models ?? null } : NONE;
      set((s) => ({ byWorkspace: { ...s.byWorkspace, [workspaceId]: next } }));
    } catch {
      set((s) => ({ byWorkspace: { ...s.byWorkspace, [workspaceId]: s.byWorkspace[workspaceId] ?? NONE } }));
    }
  },
  save: (workspaceId, change) => {
    const run = async () => {
      const current = get().byWorkspace[workspaceId];
      if (!current?.shared) throw new Error("This workspace has no shared definition yet.");
      const base = current.models ?? null;
      const next = change(base);
      if (JSON.stringify(next) === JSON.stringify(base)) return;
      await workspaceDefinitionSave(workspaceId, { models: base }, { models: next });
      await get().load(workspaceId);
    };
    const before = saving.get(workspaceId) ?? Promise.resolve();
    const mine = before.catch(() => {}).then(run);
    saving.set(workspaceId, mine.catch(() => {}));
    return mine;
  },
}));

/** The team's suggestions for a workspace, read when the caller mounts. */
export function useTeamModels(workspaceId: string | null | undefined): TeamModelsState {
  const state = useTeamModelsStore((s) => (workspaceId ? s.byWorkspace[workspaceId] : undefined));
  useEffect(() => {
    if (workspaceId) void useTeamModelsStore.getState().load(workspaceId);
  }, [workspaceId]);
  return state ?? NONE;
}

/** For the behavioural UI tests. */
export function resetTeamModelsForTests(): void {
  listening = false;
  saving.clear();
  useTeamModelsStore.setState({ byWorkspace: {} });
}
