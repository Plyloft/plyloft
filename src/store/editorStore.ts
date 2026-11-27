import { create } from "zustand";
import type { ReadOnlyPlace } from "../lib/readOnlyFile";
import type { FileRefusal } from "../lib/fileRefusal";
import { samePath } from "../lib/paths.ts";

/**
 * GH #142: this open file is a **reading view** of a copy Ply may not write.
 *
 * `place` is which of the four places it lives in — the rule that decided it is
 * `lib/readOnlyFile.ts::skillFileMode`, and it is decided where the file is
 * opened from, never here. `line` is the sentence the editor draws above the
 * document, carried with the file because the Library is the only side that
 * knows the branch's name.
 */
export type ReadOnlyCopy = {
  place: ReadOnlyPlace;
  line: string;
};

export type OpenFile = {
  path: string;
  content: string;
  initialContent: string;
  removedExternally?: boolean;
  /**
   * Set only for a copy Code may not save (GH #142). Absent is the ordinary
   * case: a file in the checkout, which the editor has always been able to
   * write.
   */
  readOnly?: ReadOnlyCopy | null;
  /**
   * Bumped every time these bytes were **loaded** rather than edited: a rebuild
   * in [`open`], and a replacement from disk.
   *
   * GH #142 review 2 (MINOR): the editor swaps its document when the active
   * *path* changes, and a rebuild keeps the path — so the store held the new
   * bytes while the `EditorView` went on showing the old ones, with the Markdown
   * preview (which renders from the store) showing the new. This is the fact the
   * swap effect watches beside the path. It is not a content hash: two loads of
   * the same bytes are still two loads, and a keystroke is not a load, which is
   * exactly the difference the effect needs.
   */
  loadId?: number;
  /**
   * UX-8.5: set when Code **could not open** this file as text (binary, over
   * 5 MB, not UTF-8). The tab shows a page saying so, with the reason, instead
   * of a document: `content` is empty and is never written — ⌘S, the reload
   * from disk and the persisted tab list all pass such a tab by. A later open
   * that reads the bytes replaces it with an ordinary tab.
   */
  refused?: FileRefusal | null;
};

/**
 * GH #174 review 1: what `open` did. Almost always `opened`; `refused` only when
 * a read-only open met a **dirty writable** tab of the same path — the tab is
 * brought forward untouched and the caller says why in a toast.
 */
export type OpenResult = { opened: true } | { opened: false; reason: string };

/** The refusal's words, shown by the Library's callers as the toast body. */
export const DIRTY_WRITABLE_REFUSAL =
  "This file has unsaved changes in its editable tab; save or discard them first.";

type WorkspaceEditorState = {
  openFiles: OpenFile[];
  activePath: string | null;
};

type EditorStore = {
  byWorkspace: Record<string, WorkspaceEditorState>;
  /**
   * `readOnly` is the whole of what makes this tab a reading view, and it is
   * **per open, not per path** (GH #142): the same path opened from a writable
   * context afterwards is writable, because the flag is replaced on reopen
   * rather than kept from the first open.
   *
   * GH #174 review 1: a read-only open of a path whose writable tab has unsaved
   * edits is **refused** — the writable tab comes forward with its edits, and
   * the answer says so. Every other open is `{ opened: true }`.
   */
  open: (
    workspaceId: string,
    path: string,
    content: string,
    readOnly?: ReadOnlyCopy | null,
  ) => OpenResult;
  /**
   * UX-8.5: open (or bring forward) a tab for a file Code cannot open, with
   * the refusal the page shows. An open tab of that path that holds text is
   * brought forward untouched — its bytes, and any unsaved edits, stay.
   */
  openRefused: (workspaceId: string, path: string, refusal: FileRefusal) => void;
  close: (workspaceId: string, path: string) => void;
  setActive: (workspaceId: string, path: string) => void;
  setContent: (workspaceId: string, path: string, content: string) => void;
  markSaved: (workspaceId: string, path: string) => void;
  replaceFromDisk: (workspaceId: string, path: string, content: string) => void;
  markRemoved: (workspaceId: string, path: string, removed: boolean) => void;
  reset: (workspaceId: string) => void;
};

function getWs(
  byWorkspace: Record<string, WorkspaceEditorState>,
  wsId: string,
): WorkspaceEditorState {
  return byWorkspace[wsId] ?? { openFiles: [], activePath: null };
}

export const useEditor = create<EditorStore>((set) => ({
  byWorkspace: {},

  open: (wsId, asked, content, readOnly) => {
    let result: OpenResult = { opened: true };
    set((state) => {
      const ws = getWs(state.byWorkspace, wsId);
      // One tab per file, however its path was spelled (Windows: either
      // separator, any case): the tab keeps the spelling it was opened with.
      const already = ws.openFiles.find((f) => samePath(f.path, asked));
      const path = already?.path ?? asked;
      if (already) {
        const next = readOnly ?? null;
        // GH #174 review 1 (MINOR): a dirty **writable** tab is never rebuilt
        // into a reading view — that would drop the member's unsaved edits
        // without a word. The roots are not disjoint after all: a workspace
        // rooted at `~/.claude` has `CLAUDE.md` both as a checkout file and as
        // `On this Mac`'s personal file. So the writable tab comes forward, as
        // it is, and the caller is told why nothing else happened.
        if (next !== null && !already.readOnly && already.content !== already.initialContent) {
          result = { opened: false, reason: DIRTY_WRITABLE_REFUSAL };
          return {
            byWorkspace: {
              ...state.byWorkspace,
              [wsId]: { ...ws, activePath: path },
            },
          };
        }
        // Two writable opens of one path: the tab is simply brought forward,
        // unsaved edits and all — reopening a file from the tree has never
        // discarded them, and that is the whole reason this shortcut exists.
        //
        // A **read-only** reopen never takes it (review 1, MINOR). Nothing
        // refreshes a reading view once it is open: no file watcher covers
        // Application Support or `~/.claude` (`fs_watch_start` watches the
        // workspace's own cwd), there is no ⌘S to pull one, and `generation`
        // reloads the Library's own page and not the editor. So the shortcut
        // meant that pressing `Open in Code` on a personal skill an hour after
        // the first press showed the first press's bytes, silently, with a
        // banner claiming to be reading the file on disk. Every read-only open
        // has just read that file; those bytes are the freshest Ply has, and
        // they win.
        // UX-8.5: a tab showing the "can't open here" page is always rebuilt:
        // this open read the bytes it could not.
        const bringForward = !already.refused;
        if (next === null && (already.readOnly ?? null) === null) {
          if (bringForward) {
            return {
              byWorkspace: {
                ...state.byWorkspace,
                [wsId]: { ...ws, activePath: path },
              },
            };
          }
        }
        // Rebuilt from the bytes this open just read: a reading view must never
        // become a writable tab that still carries the read-only file's dirty
        // baseline, and a writable tab must never keep the flag once the file is
        // opened as the checkout's.
        //
        // Nothing unsaved is lost here: a dirty writable tab reopened read-only
        // was refused above (GH #174 review 1 — the roots can overlap, e.g. a
        // workspace rooted at `~/.claude`), and a read-only tab is never dirty
        // (`isFileDirty`), so the other direction has no edit to keep.
        return {
          byWorkspace: {
            ...state.byWorkspace,
            [wsId]: {
              openFiles: ws.openFiles.map((f) =>
                samePath(f.path, path)
                  ? {
                      path,
                      content,
                      initialContent: content,
                      // Same path, new bytes: the view has to be told, and the
                      // path alone cannot tell it (review 2).
                      loadId: (f.loadId ?? 0) + 1,
                      ...(next ? { readOnly: next } : {}),
                    }
                  : f,
              ),
              activePath: path,
            },
          },
        };
      }
      return {
        byWorkspace: {
          ...state.byWorkspace,
          [wsId]: {
            openFiles: [
              ...ws.openFiles,
              {
                path,
                content,
                initialContent: content,
                ...(readOnly ? { readOnly } : {}),
              },
            ],
            activePath: path,
          },
        },
      };
    });
    return result;
  },

  openRefused: (wsId, asked, refusal) =>
    set((state) => {
      const ws = getWs(state.byWorkspace, wsId);
      const already = ws.openFiles.find((f) => samePath(f.path, asked));
      const path = already?.path ?? asked;
      if (already && !already.refused) {
        return {
          byWorkspace: { ...state.byWorkspace, [wsId]: { ...ws, activePath: path } },
        };
      }
      const tab: OpenFile = {
        path,
        content: "",
        initialContent: "",
        refused: refusal,
        loadId: (already?.loadId ?? 0) + 1,
      };
      return {
        byWorkspace: {
          ...state.byWorkspace,
          [wsId]: {
            openFiles: already
              ? ws.openFiles.map((f) => (samePath(f.path, path) ? tab : f))
              : [...ws.openFiles, tab],
            activePath: path,
          },
        },
      };
    }),

  close: (wsId, path) =>
    set((state) => {
      const ws = state.byWorkspace[wsId];
      if (!ws) return state;
      const newFiles = ws.openFiles.filter((f) => !samePath(f.path, path));
      let active = ws.activePath;
      if (active !== null && samePath(active, path)) {
        active = newFiles[newFiles.length - 1]?.path ?? null;
      }
      return {
        byWorkspace: {
          ...state.byWorkspace,
          [wsId]: { openFiles: newFiles, activePath: active },
        },
      };
    }),

  setActive: (wsId, asked) =>
    set((state) => {
      const ws = state.byWorkspace[wsId];
      if (!ws) return state;
      // The open tab's own spelling, so `activePath` matches it exactly.
      const path = ws.openFiles.find((f) => samePath(f.path, asked))?.path ?? asked;
      return {
        byWorkspace: {
          ...state.byWorkspace,
          [wsId]: { ...ws, activePath: path },
        },
      };
    }),

  setContent: (wsId, path, content) =>
    set((state) => {
      const ws = state.byWorkspace[wsId];
      if (!ws) return state;
      return {
        byWorkspace: {
          ...state.byWorkspace,
          [wsId]: {
            ...ws,
            openFiles: ws.openFiles.map((f) =>
              samePath(f.path, path) ? { ...f, content } : f,
            ),
          },
        },
      };
    }),

  // GH #142: never for a read-only copy. Nothing writes one, so nothing has a
  // save to mark — and a `markSaved` that moved the baseline would be the one
  // way a reading view could claim a write that did not happen.
  markSaved: (wsId, path) =>
    set((state) => {
      const ws = state.byWorkspace[wsId];
      if (!ws) return state;
      if (ws.openFiles.find((f) => samePath(f.path, path))?.readOnly) return state;
      // UX-8.5: nor a file Code could not open; it has no text to save.
      if (ws.openFiles.find((f) => samePath(f.path, path))?.refused) return state;
      return {
        byWorkspace: {
          ...state.byWorkspace,
          [wsId]: {
            ...ws,
            openFiles: ws.openFiles.map((f) =>
              samePath(f.path, path) ? { ...f, initialContent: f.content } : f,
            ),
          },
        },
      };
    }),

  replaceFromDisk: (wsId, path, content) =>
    set((state) => {
      const ws = state.byWorkspace[wsId];
      if (!ws) return state;
      return {
        byWorkspace: {
          ...state.byWorkspace,
          [wsId]: {
            ...ws,
            openFiles: ws.openFiles.map((f) =>
              samePath(f.path, path)
                ? {
                    ...f,
                    content,
                    initialContent: content,
                    removedExternally: false,
                    // A load, like a rebuild: the view is dispatched into
                    // directly when this file is the active one, and the swap
                    // effect then finds the document already right and leaves
                    // the selection alone (review 2).
                    loadId: (f.loadId ?? 0) + 1,
                  }
                : f,
            ),
          },
        },
      };
    }),

  markRemoved: (wsId, path, removed) =>
    set((state) => {
      const ws = state.byWorkspace[wsId];
      if (!ws) return state;
      return {
        byWorkspace: {
          ...state.byWorkspace,
          [wsId]: {
            ...ws,
            openFiles: ws.openFiles.map((f) =>
              samePath(f.path, path) ? { ...f, removedExternally: removed } : f,
            ),
          },
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

/**
 * Unsaved changes, and so: the dirty dot, the discard-on-close question, the
 * external-write prompt, and what Ship lists.
 *
 * A read-only copy is never dirty (GH #142). Its `EditorView` is not editable,
 * so its content cannot move off the baseline in the first place — this is the
 * second lock, so that a future path that did move it still could not present a
 * reading view as something with a change to save.
 */
export function isFileDirty(file: OpenFile | undefined): boolean {
  return !!file && !file.readOnly && file.content !== file.initialContent;
}
