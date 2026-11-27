import { create } from "zustand";

/**
 * QoL 7.2 (B2): the one "Add a project" sheet — the sidebar switcher's `+`,
 * ⌘K "Add a project…" and the zero-project screen all open it. Session-only:
 * nothing here is persisted.
 */
interface AddProjectState {
  open: boolean;
  openAddProject: () => void;
  closeAddProject: () => void;
}

export const useAddProject = create<AddProjectState>((set) => ({
  open: false,
  openAddProject: () => set({ open: true }),
  closeAddProject: () => set({ open: false }),
}));

/** The one name every entry uses. */
export const ADD_PROJECT_LABEL = "Add a project";
