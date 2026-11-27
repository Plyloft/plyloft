import { create } from "zustand";

/**
 * GH #268: which Markdown files show their rendered preview, per workspace
 * and path. Session-only (never persisted): it survives tab and workspace
 * switches, and resets on restart. Its own store because two places use it —
 * the Code header's Preview toggle (the page's action) and the editor, which
 * swaps the document for the rendering.
 */
type MarkdownPreviewStore = {
  on: Record<string, Record<string, boolean>>;
  toggle: (workspaceId: string, path: string) => void;
};

export const useMarkdownPreview = create<MarkdownPreviewStore>((set) => ({
  on: {},
  toggle: (workspaceId, path) =>
    set((s) => {
      const ws = s.on[workspaceId] ?? {};
      return { on: { ...s.on, [workspaceId]: { ...ws, [path]: !ws[path] } } };
    }),
}));
