import { create } from "zustand";
import {
  templatesCreate,
  templatesDelete,
  templatesList,
  templatesUpdate,
  type UserTemplate,
} from "../ipc";

type TemplatesState = {
  userTemplates: UserTemplate[];
  loading: boolean;
  loaded: boolean;
  error: string | null;
  /** v1.51.0 (Team Mode Phase 2.2): pass the active workspace's cwd to
   *  merge `<cwd>/.atelier/library/templates.json` (scope=shared) into
   *  the result. Omit for personal-only. */
  refresh: (projectCwd?: string | null) => Promise<void>;
  create: (template: UserTemplate) => Promise<UserTemplate>;
  update: (template: UserTemplate) => Promise<UserTemplate>;
  remove: (id: string) => Promise<void>;
};

export const useUserTemplates = create<TemplatesState>((set, get) => ({
  userTemplates: [],
  loading: false,
  loaded: false,
  error: null,
  refresh: async (projectCwd) => {
    set({ loading: true, error: null });
    try {
      const userTemplates = await templatesList(projectCwd);
      set({ userTemplates, loading: false, loaded: true });
    } catch (e) {
      set({ loading: false, error: String(e) });
    }
  },
  create: async (template) => {
    const saved = await templatesCreate(template);
    set({ userTemplates: [...get().userTemplates, saved] });
    return saved;
  },
  update: async (template) => {
    const saved = await templatesUpdate(template);
    set({
      userTemplates: get().userTemplates.map((t) =>
        t.id === saved.id ? saved : t,
      ),
    });
    return saved;
  },
  remove: async (id) => {
    await templatesDelete(id);
    set({ userTemplates: get().userTemplates.filter((t) => t.id !== id) });
  },
}));
