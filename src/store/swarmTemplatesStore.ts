import { create } from "zustand";
import { swarmTemplatesList, type SwarmTemplate } from "../ipc";

type SwarmTemplatesState = {
  /** Startable builtins + user-defined, merged. Retired historical templates
   * are resolved separately by exact id and never enter this picker catalog. */
  templates: SwarmTemplate[];
  loading: boolean;
  loaded: boolean;
  error: string | null;
  /** v1.51.0 (Team Mode Phase 2.2): pass the active workspace's cwd to
   *  merge `<cwd>/.atelier/library/swarm_templates.json` (scope=shared)
   *  into the result. Omit for personal-only. Builtins always come back
   *  scope=personal regardless. */
  refresh: (projectCwd?: string | null) => Promise<void>;
  // GH #171: create / update / remove / fork / promote / demote went with
  // Settings › Swarm templates, the only surface that edited templates. The
  // catalogue is read-only now: a swarm run's view reads it (G4: the card
  // picker and Brainstorm went with the swarm UI).
  /** Convenience for pickers: lookup by id, returns undefined if missing. */
  get: (id: string) => SwarmTemplate | undefined;
};

export const useSwarmTemplates = create<SwarmTemplatesState>((set, get) => ({
  templates: [],
  loading: false,
  loaded: false,
  error: null,
  refresh: async (projectCwd) => {
    set({ loading: true, error: null });
    try {
      const templates = await swarmTemplatesList(projectCwd);
      set({ templates, loading: false, loaded: true });
    } catch (e) {
      set({ loading: false, error: String(e) });
    }
  },
  get: (id) => get().templates.find((t) => t.id === id),
}));
