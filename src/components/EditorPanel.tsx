import { FolderVersionLine } from "./FolderVersionLine";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { noteFileSaved } from "../store/allSkillsStore";
import { noteEditorSave } from "../store/folderChanges";
import { EditorState, Compartment, Facet } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightSpecialChars,
  drawSelection,
} from "@codemirror/view";
import {
  defaultKeymap,
  indentWithTab,
  history,
  historyKeymap,
  isolateHistory,
  toggleComment,
} from "@codemirror/commands";
import {
  searchKeymap,
  highlightSelectionMatches,
  setSearchQuery,
  SearchQuery,
  search,
} from "@codemirror/search";
import { autocompletion, completionKeymap } from "@codemirror/autocomplete";
import {
  indentOnInput,
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentUnit,
} from "@codemirror/language";
import { PLY_SYNTAX, editorTheme } from "./editorTheme";
import { zoomKeyAction } from "../lib/textSize";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { rust } from "@codemirror/lang-rust";
import { python } from "@codemirror/lang-python";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { invoke } from "@tauri-apps/api/core";
import type { Extension, StateEffect } from "@codemirror/state";
import { useEditor, isFileDirty, type OpenFile } from "../store/editorStore";
import { COPY_INTO_PROJECT, OUTSIDE_LINE, READ_ONLY_TAB } from "../lib/readOnlyFile";
import { isMarkdownPath } from "../lib/markdownPath";
import { useMarkdownPreview } from "../store/markdownPreviewStore";
import { indentsWithTabs } from "../lib/indentStyle";
import { dismissToast, pushToast } from "../store/toastStore";
import { DropRefusedError, openDroppedFile, toastDropRefusals, type DropRefusal } from "../lib/droppedFile";
import {
  BINARY_SNIFF_BYTES,
  EDITOR_DROP_KINDS,
  acceptsAttr,
  acceptsDrag,
  droppedFileRejection,
} from "../lib/dropGuard";
import { ConfirmDialog } from "./ConfirmDialog";
import { CodeOpener } from "./CodeOpener";
import { ErrorBlock, Icon } from "./ux";
import { CBtn } from "./ui/primitives";
import { rawError } from "../lib/cardPage";
import { closeEditorTab, onOpenFileSaved } from "../lib/editorSave";
import { revealFailedError, saveFailedError } from "../lib/codeErrors";
import { fileRefusal } from "../lib/fileRefusal";
import { fsCopyIntoWorkspace, fsRevealInWorkspace } from "../ipc";
import { openInEditor } from "../lib/openInEditor";
import "./code.css";
// Lazy-loaded to keep marked + dompurify out of the initial module graph;
// the WKWebView was failing to initialize when these were imported eagerly.
import { useColorScheme } from "../hooks/useColorScheme";
import { onFileChange } from "../ipc";
import { useWorkspaces } from "../store/workspaceStore";
import { relativeToWorkspace } from "../lib/workspacePath";
import { useSettings } from "../store/settingsStore";
import { useTextSize, zoomText } from "../store/textZoomStore";
import { formatKeys, platformWord } from "../lib/platform";
import { isItalianCommentChord } from "../lib/shortcuts";
import { isNotTextOnDisk, markNotTextOnDisk, notTextLine } from "../lib/diskNotText";
import { confirmSheet } from "../store/confirmStore";
import { basename, pathKey, samePath } from "../lib/paths";
import { pushErrorToast } from "../lib/errorToast";

/** Challenger L5: how long a tab reloaded from disk says "Updated". */
export const UPDATED_MARK_MS = 3000;

/** Save, as the platform draws it. */
const SAVE_KEYS = formatKeys("⌘S");

function langExtensionFor(path: string): Extension[] {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "ts":
      return [javascript({ typescript: true })];
    case "tsx":
      return [javascript({ typescript: true, jsx: true })];
    case "jsx":
      return [javascript({ jsx: true })];
    case "js":
    case "mjs":
    case "cjs":
      return [javascript()];
    case "json":
      return [json()];
    case "md":
    case "markdown":
      return [markdown()];
    case "rs":
      return [rust()];
    case "py":
      return [python()];
    case "html":
    case "htm":
      return [html()];
    case "css":
    case "scss":
      return [css()];
    default:
      return [];
  }
}

/**
 * GH #170: **one `EditorState` per open file.** The view is one `EditorView`, and
 * a tab switch hands it the incoming file's own state with `view.setState` — so
 * each file keeps its own undo history, selection and (through a scroll
 * snapshot) scroll position, and nothing one file's bytes do can enter another
 * file's history.
 *
 * This replaces GH #142's `LOAD` annotation. With one state for every tab, a
 * buffer load had to be kept out of the shared history or ⌘Z on the next tab
 * pasted the previous tab's whole document into it (review 1, MAJOR) — and, as
 * the price of that, a typed edit no longer survived a tab switch. Per-file
 * histories make the leak structurally impossible instead of something every
 * writer has to remember: there is no whole-document dispatch that carries
 * another file's bytes, because a tab switch is not a dispatch at all.
 *
 * Which file a state belongs to is carried **in the state** (`FILE_PATH`), not
 * in a ref beside it: `saveCmd` and the change listener read it off the state
 * they were handed, so a state can only ever write to, and only ever dirty, its
 * own file. A state with no path — the blank shown when the last tab closes —
 * writes nothing and dirties nothing.
 */
const FILE_PATH = Facet.define<string, string | null>({
  combine: (paths) => paths[0] ?? null,
});

// The compartment contents are module constants so a stored state can be
// compared against what it should show by identity (`Compartment.get`) when it
// is switched back in — the theme or the wrap may have changed while it waited.
// GH #265: one Ply editor theme on tokens (./editorTheme) for light, dark
// and void — void's black canvas included, which stock One Dark overrode.
const WRAP_ON: Extension = [EditorView.lineWrapping];
const WRAP_OFF: Extension = [];
// GH #205: Settings › Code › Line numbers. Only the numbers come and go; the
// fold gutter stays. CodeMirror draws gutters in the order their extensions
// come, so this compartment goes **before** the shared extensions (which hold
// `foldGutter()`) in every state: numbers first, fold markers after them, as
// they were when `lineNumbers()` headed the shared list (review 1, M1).
const LINE_NUMBERS_ON: Extension = [lineNumbers()];
const LINE_NUMBERS_OFF: Extension = [];
// GH #205: Settings › Code › Tab size — how wide a tab character is drawn
// (`tabSize`) and what one indent step inserts (`indentUnit`). The setting
// reads "N spaces", so a file that indents with spaces, or not yet at all,
// gets N spaces per step (Tab, Enter's auto-indent, `indentOnInput`). A file
// that indents with tabs — a Makefile, Go — keeps tabs: its unit is "\t",
// drawn N columns wide (review 1, m2; the rule is `indentsWithTabs`, read once
// from the bytes the state is created with and carried in the state by
// `INDENT_TABS`, like its path). One extension per width and style, kept here,
// so a stored state compares by identity like the theme and the wrap.
const INDENT_TABS = Facet.define<boolean, boolean>({
  combine: (values) => values[0] ?? false,
});
const INDENT_BY_KEY = new Map<string, Extension>();
/** UX P-D2: a preview that couldn't be drawn says so plainly; the renderer's
 *  own error, escaped, is behind a closed Details. */
function previewFailedHtml(raw: string): string {
  const escaped = raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return (
    `<p class="md-preview-error">Plyloft couldn't draw the preview of this file.</p>` +
    `<details><summary>Details</summary><pre>${escaped}</pre></details>`
  );
}

/** Every line end in `text` is CRLF (and there is at least one). A file
 *  that mixes them keeps CodeMirror's own reading. */
function usesCrlf(text: string): boolean {
  return text.includes("\r\n") && !/(^|[^\r])\n/.test(text);
}

function indentFor(size: number, tabs: boolean): Extension {
  const n = Number.isFinite(size) ? Math.max(1, Math.min(8, Math.round(size))) : 2;
  const key = `${n}:${tabs ? "tab" : "space"}`;
  let ext = INDENT_BY_KEY.get(key);
  if (!ext) {
    ext = [EditorState.tabSize.of(n), indentUnit.of(tabs ? "\t" : " ".repeat(n))];
    INDENT_BY_KEY.set(key, ext);
  }
  return ext;
}
// Both halves, because they are two different refusals: `readOnly` stops every
// transaction that changes the document (a command, a paste, `indentWithTab`,
// and `undo`, which returns false on a read-only state), and `editable(false)`
// takes the content out of the tab order and stops the browser's own editing
// affordances (GH #142).
const READ_ONLY: Extension = [EditorState.readOnly.of(true), EditorView.editable.of(false)];
const EDITABLE: Extension = [];
/** GH #170: a reload from disk is one undo step, never merged into typing. */
const RELOAD = isolateHistory.of("full");

type Props = {
  workspaceId: string;
};

export function EditorPanel({ workspaceId }: Props) {
  const wsState = useEditor((s) => s.byWorkspace[workspaceId]);
  const setActive = useEditor((s) => s.setActive);
  const setContent = useEditor((s) => s.setContent);
  const markSaved = useEditor((s) => s.markSaved);

  const containerRef = useRef<HTMLDivElement | null>(null);
  /** The whole content area: the drop zone that opens a dropped file. */
  const dropHostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const langCompRef = useRef<Compartment | null>(null);
  const themeCompRef = useRef<Compartment | null>(null);
  const wrapCompRef = useRef<Compartment | null>(null);
  /** GH #205: Settings › Code › Line numbers. */
  const gutterCompRef = useRef<Compartment | null>(null);
  /** GH #205: Settings › Code › Tab size (`tabSize` + `indentUnit`). */
  const indentCompRef = useRef<Compartment | null>(null);
  /** GH #142: a file's read-only extensions — fixed for the life of its state. */
  const readOnlyCompRef = useRef<Compartment | null>(null);
  /** The extensions every file's state shares (keymap, listener, gutters…). */
  const baseExtRef = useRef<Extension | null>(null);
  /**
   * GH #170: the path whose state is in the view now, or null for the blank.
   * The swap effect is its only writer.
   */
  const activePathRef = useRef<string | null>(null);
  /**
   * GH #170: each open file's own `EditorState` — its document, undo history
   * and selection — while another file is in the view. Kept here, not in the
   * store: a state is neither serialisable nor persisted, and it lives exactly
   * as long as its tab (closing the tab drops it; this panel is the workspace's
   * one editor, so unmounting it drops them all). The state of the file that is
   * showing is `view.state`; its entry here is refreshed when it is switched out.
   */
  const statesRef = useRef(new Map<string, EditorState>());
  /** GH #170: where each stored file was scrolled to, restored on switch-in. */
  const scrollRef = useRef(new Map<string, StateEffect<unknown>>());
  const workspaceIdRef = useRef<string>(workspaceId);
  workspaceIdRef.current = workspaceId;
  const theme = useColorScheme();
  const themeRef = useRef(theme);
  themeRef.current = theme;

  const activeFile = wsState?.openFiles.find(
    (f) => f.path === wsState?.activePath,
  );
  const hasFiles = !!wsState && wsState.openFiles.length > 0;
  // GH #142: the open copy is one Ply may not write — the mirror of the
  // integration branch, the team library, this Mac's own folder, the app's own
  // bundle. Read off the file, never re-derived from its path.
  const readOnly = activeFile?.readOnly ?? null;
  // UX-8.5: the active tab is a file Code could not open as text.
  const refused = activeFile?.refused ?? null;

  // Per-path markdown preview. GH #268: toggled from the Code header (the
  // page's action), so it lives in a store both read.
  const previewByPath = useMarkdownPreview((s) => s.on[workspaceId]);
  const [previewHtml, setPreviewHtml] = useState<string>("");
  const showingPreview = !!(
    activeFile &&
    !refused &&
    isMarkdownPath(activeFile.path) &&
    previewByPath?.[activeFile.path]
  );

  // Per-path soft-wrap override. Mirrors previewByPath: session-only — survives
  // tab/workspace switches, resets on app restart. Markdown wraps by default;
  // every other file follows the global editor.wordWrap setting. The status-bar
  // button overrides per-file for the session.
  const wordWrap = useSettings((s) => s.settings.editor.wordWrap);
  const [wrapByPath, setWrapByPath] = useState<Record<string, boolean>>({});
  /** GH #308: a ⌘S that failed, by path — the raw error, for Details. Said on
   *  the tab and under the tabs until the file saves or it is dismissed. */
  const [saveFailures, setSaveFailures] = useState<Record<string, string>>({});
  /** Challenger L5: tabs just reloaded from disk in silence, marked
   *  "Updated" for a few seconds (by path, with the mark's own count). */
  const [updated, setUpdated] = useState<Record<string, number>>({});
  /** Windows re-check of block 6: tabs whose file on disk stopped being text. */
  const [notText, setNotText] = useState<Record<string, true>>({});
  function setDiskNotText(path: string, on: boolean) {
    markNotTextOnDisk(workspaceIdRef.current, path, on);
    setNotText(({ [path]: _was, ...rest }) => (on ? { ...rest, [path]: true } : rest));
  }
  const updatedTimers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const timers = updatedTimers.current;
    return () => timers.forEach(clearTimeout);
  }, []);
  function markUpdated(path: string) {
    let mine = 0;
    setUpdated((u) => {
      mine = (u[path] ?? 0) + 1;
      return { ...u, [path]: mine };
    });
    const timer = setTimeout(() => {
      updatedTimers.current.delete(timer);
      setUpdated(({ [path]: at, ...rest }) => (at === mine ? rest : { ...rest, [path]: at }));
    }, UPDATED_MARK_MS);
    updatedTimers.current.add(timer);
  }
  // QoL 1.168 review: a save made outside the text (Save all, Save and
  // close) clears the tab's "Not saved" too.
  useEffect(
    () =>
      onOpenFileSaved((ws, path) => {
        if (ws !== workspaceId) return;
        // Saved over a file that had stopped being text: the notice goes too.
        setNotText(({ [path]: _gone, ...rest }) => rest);
        setSaveFailures((s) => {
          if (!(path in s)) return s;
          const { [path]: _saved, ...rest } = s;
          return rest;
        });
      }),
    [workspaceId],
  );
  const effectiveWrap = (path: string): boolean =>
    wrapByPath[path] ?? (isMarkdownPath(path) ? true : wordWrap);
  const activeWrap = activeFile ? effectiveWrap(activeFile.path) : false;

  // GH #205: the two other This-Mac editor settings, live in every open state —
  // the one showing follows at once (the effect below), a stored one when it is
  // switched back in (the swap effect). Refs as well, for the blank state the
  // mount effect builds from its first render.
  const tabSize = useSettings((s) => s.settings.editor.tabSize);
  const showLineNumbers = useSettings((s) => s.settings.editor.lineNumbers);
  // QoL 1.168 (block 10, A7): the text size, a CSS variable on the host; the
  // view measures its lines again when it changes.
  const editorTextPx = useTextSize("editor");
  useEffect(() => {
    viewRef.current?.requestMeasure();
  }, [editorTextPx]);
  const tabSizeRef = useRef(tabSize);
  tabSizeRef.current = tabSize;
  const lineNumbersRef = useRef(showLineNumbers);
  lineNumbersRef.current = showLineNumbers;
  const gutterExt = (): Extension =>
    lineNumbersRef.current ? LINE_NUMBERS_ON : LINE_NUMBERS_OFF;
  // Render markdown in an effect so the marked/dompurify deps are loaded
  // dynamically — keeps them out of the App's initial module graph.
  useEffect(() => {
    let cancelled = false;
    if (!showingPreview || !activeFile) {
      setPreviewHtml("");
      return;
    }
    const content = activeFile.content;
    import("../lib/markdown")
      .then(({ renderMarkdown }) => {
        if (!cancelled) setPreviewHtml(renderMarkdown(content));
      })
      .catch((e) => {
        if (!cancelled)
          setPreviewHtml(previewFailedHtml(String(e)));
      });
    return () => {
      cancelled = true;
    };
  }, [showingPreview, activeFile?.content, activeFile?.path]);

  const [pendingExternal, setPendingExternal] = useState<{
    path: string;
    name: string;
    diskContent: string;
  } | null>(null);

  const replaceFromDisk = useEditor((s) => s.replaceFromDisk);
  const markRemoved = useEditor((s) => s.markRemoved);
  const reloadStrategy = useSettings(
    (s) => s.settings.behavior.externalWriteReloadStrategy,
  );

  /**
   * GH #170 (review 1): a file's current state — the live `view.state` when that
   * file is the one showing (its map entry is only refreshed on switch-out), the
   * stored one otherwise, or none if it was never shown. The one way the map is
   * read.
   */
  function stateOf(path: string): EditorState | undefined {
    const view = viewRef.current;
    if (view && view.state.facet(FILE_PATH) === path) return view.state;
    return statesRef.current.get(path);
  }

  /**
   * GH #170: a new state for one open file — its bytes, its own `history()`, and
   * its own language, read-only flag, wrap and theme. Called on a file's first
   * switch-in, and again only when the store **loaded** bytes this state does not
   * hold (see the swap effect).
   */
  function createFileState(file: OpenFile): EditorState {
    const tabs = indentsWithTabs(file.content);
    return EditorState.create({
      doc: file.content,
      extensions: [
        gutterCompRef.current!.of(gutterExt()),
        baseExtRef.current ?? [],
        FILE_PATH.of(file.path),
        INDENT_TABS.of(tabs),
        // Windows re-check of block 6: a CRLF file keeps its line ends.
        // CodeMirror joins lines with "\n" by default, so the first keystroke
        // turned every line end to LF in the store — the tab stayed "Unsaved"
        // when the text was typed back, and ⌘S rewrote every line end.
        ...(usesCrlf(file.content) ? [EditorState.lineSeparator.of("\r\n")] : []),
        langCompRef.current!.of(langExtensionFor(file.path)),
        themeCompRef.current!.of(editorTheme(themeRef.current)),
        indentCompRef.current!.of(indentFor(tabSizeRef.current, tabs)),
        wrapCompRef.current!.of(effectiveWrap(file.path) ? WRAP_ON : WRAP_OFF),
        readOnlyCompRef.current!.of(file.readOnly || file.refused ? READ_ONLY : EDITABLE),
      ],
    });
  }

  /**
   * What the view shows with no file open: no path, so nothing it does reaches
   * the store or the disk, and read-only, because there is nothing to edit. The
   * `CodeOpener` overlay sits on top of it.
   */
  function createBlankState(): EditorState {
    return EditorState.create({
      doc: "",
      extensions: [
        gutterCompRef.current!.of(gutterExt()),
        baseExtRef.current ?? [],
        langCompRef.current!.of([]),
        themeCompRef.current!.of(editorTheme(themeRef.current)),
        indentCompRef.current!.of(indentFor(tabSizeRef.current, false)),
        wrapCompRef.current!.of(WRAP_OFF),
        readOnlyCompRef.current!.of(READ_ONLY),
      ],
    });
  }

  // Mount EditorView once. Container is always in the DOM. It starts on the
  // blank state; the swap effect right below hands it the active file's state in
  // the same commit, so no frame shows a read-only file as editable.
  useEffect(() => {
    if (!containerRef.current) return;

    langCompRef.current = new Compartment();
    themeCompRef.current = new Compartment();
    wrapCompRef.current = new Compartment();
    gutterCompRef.current = new Compartment();
    indentCompRef.current = new Compartment();
    readOnlyCompRef.current = new Compartment();

    /**
     * ⌘S. **The only call in this file that writes a file** (GH #142), and it
     * refuses a read-only copy before it invokes anything.
     *
     * The path is the state's own (`FILE_PATH`, GH #170): the bytes written are
     * the document of the state that carries that path, so ⌘S can only ever
     * write a file's own document to that file. Whether that file is a reading
     * view is read from the store — a fact about the open file, not about the
     * view. It returns `true` either way, so the keystroke is consumed and the
     * webview's own Save never sees it; the banner above the document is what
     * says why nothing happened.
     */
    const saveCmd = (target: EditorView) => {
      const path = target.state.facet(FILE_PATH);
      if (!path) return false;
      const file = useEditor
        .getState()
        .byWorkspace[workspaceIdRef.current]?.openFiles.find(
          (f) => f.path === path,
        );
      if (file?.readOnly) return true;
      // UX-8.5: nor a tab showing the "can't open here" page — its document
      // is empty, and writing it would empty the file on disk.
      if (file?.refused) return true;
      // `sliceDoc` joins with the file's own line ends (CRLF kept).
      const content = target.state.sliceDoc();
      const ws = workspaceIdRef.current;
      // Windows re-check of block 6: the disk holds something this tab never
      // read (it stopped being text); writing over it is asked first.
      if (isNotTextOnDisk(ws, path)) {
        void confirmSheet({
          title: `Replace ${basename(path)} on disk?`,
          body: "The file changed on disk and isn't plain text any more. Saving writes this tab's text over it.",
          confirmLabel: "Replace",
          destructive: true,
        }).then((ok) => {
          if (ok) writeFile(ws, path, content);
        });
        return true;
      }
      writeFile(ws, path, content);
      return true;
    };

    function writeFile(ws: string, path: string, content: string) {
      invoke<void>("fs_write_text_file", { path, content })
        .then(() => {
          markNotTextOnDisk(ws, path, false);
          setNotText(({ [path]: _gone, ...rest }) => rest);
          markSaved(ws, path);
          // Skills hub H7: the watcher drops Plyloft's own writes, so All
          // skills hears of a saved skill file from here.
          noteFileSaved(ws, path);
          // 1.174.0 E1: and "Same folder" counts it.
          noteEditorSave(ws, path);
          setSaveFailures(({ [path]: _saved, ...rest }) => rest);
        })
        .catch((e) => setSaveFailures((s) => ({ ...s, [path]: rawError(e) })));
    }

    baseExtRef.current = [
      highlightActiveLine(),
      highlightSpecialChars(),
      drawSelection(),
      // One per state, so one per open file (GH #170).
      history(),
      indentOnInput(),
      bracketMatching(),
      foldGutter(),
      PLY_SYNTAX,
      highlightSelectionMatches(),
      // QoL 3.4 (E9): the search state is there from the start (it was added
      // when the panel first opened), so an In files match can set its query
      // and ⌘G step through it before the panel was ever shown.
      search(),
      autocompletion(),
      keymap.of([
        { key: "Mod-s", run: saveCmd, preventDefault: true },
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        ...foldKeymap,
        ...completionKeymap,
        indentWithTab,
      ]),
      // QoL walk of block 6: an Italian keyboard's ⌘/ is ⌘⇧7, which WebKit
      // reports as key "7" — CodeMirror's Mod-/ never matches it.
      // QoL 1.168 (block 10, A7): ⌘= / ⌘− / ⌘0 (Ctrl on Windows) step the
      // editor's text size, as the Settings row does.
      EditorView.domEventHandlers({
        keydown(event, view) {
          if (isItalianCommentChord(event)) {
            event.preventDefault();
            toggleComment(view);
            return true;
          }
          const zoom = zoomKeyAction(event);
          if (!zoom) return false;
          event.preventDefault();
          zoomText("editor", zoom);
          return true;
        },
      }),
      // A change is recorded against the file whose state it happened in.
      EditorView.updateListener.of((update) => {
        const path = update.state.facet(FILE_PATH);
        if (update.docChanged && path) {
          setContent(workspaceIdRef.current, path, update.state.sliceDoc());
        }
      }),
      EditorView.theme({
        // QoL 1.168 (block 10, A7): Settings › Editor text size, set on
        // the host as a variable so every file's state follows it live.
        "&": { height: "100%", fontSize: "var(--ply-editor-text-size, 13px)" },
        ".cm-scroller": {
          fontFamily: 'SF Mono, Menlo, "Cascadia Mono", Consolas, monospace',
          lineHeight: "1.5",
          overflow: "auto",
        },
        ".cm-content": { padding: "8px 0" },
      }),
    ];

    const view = new EditorView({
      parent: containerRef.current,
      state: createBlankState(),
    });
    viewRef.current = view;
    activePathRef.current = null;

    const states = statesRef.current;
    const scrolls = scrollRef.current;
    return () => {
      view.destroy();
      viewRef.current = null;
      activePathRef.current = null;
      // The states were built on this mount's compartments and keymap; a
      // remount rebuilds each file's state from the store.
      states.clear();
      scrolls.clear();
      baseExtRef.current = null;
      langCompRef.current = null;
      themeCompRef.current = null;
      wrapCompRef.current = null;
      gutterCompRef.current = null;
      indentCompRef.current = null;
      readOnlyCompRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setContent, markSaved]);

  // GH #170: put the active file's **own state** in the view when the active
  // file changes — or when its bytes were loaded again under the same path (GH
  // #142 review 2: a read-only reopen rebuilds the open file in place, so the
  // path alone cannot tell this effect). `loadId`, not the content: a keystroke
  // changes the content and must not re-run this.
  //
  // - The outgoing file's state is kept as it is — document, history, selection
  //   — with a snapshot of its scroll, unless its tab was closed.
  // - The incoming file's stored state is reused while it still holds exactly
  //   the store's bytes and the store's read-only flag. Otherwise the store has
  //   **loaded** something this state never saw — a read-only reopen's fresh
  //   bytes, or the same path reopened with the other flag — and the file gets a
  //   **new** state from those bytes: a new document is a new history, and a
  //   reading view's history, or a writable tab's from before it became one, is
  //   nothing the member should be able to ⌘Z into. A reload from disk never
  //   takes this branch: `reloadIntoOwnState` applies it to the file's state
  //   before it tells the store, so the bytes already match and the reload stays
  //   undoable (GH #142 review 2).
  // - A theme, wrap, line-number or tab-size change made while the state waited
  //   is applied on the way in (the effects below only reach the state that is
  //   showing).
  useEffect(() => {
    const view = viewRef.current;
    const themeComp = themeCompRef.current;
    const wrapComp = wrapCompRef.current;
    const gutterComp = gutterCompRef.current;
    const indentComp = indentCompRef.current;
    if (!view || !themeComp || !wrapComp || !gutterComp || !indentComp) return;
    const states = statesRef.current;
    const scrolls = scrollRef.current;

    const openFiles = wsState?.openFiles ?? [];
    const outgoing = activePathRef.current;
    // Only a tab that is still open is kept. When the showing tab is the one
    // being closed this skips it; the prune effect below is what guarantees a
    // closed tab's state is gone either way.
    if (outgoing && openFiles.some((f) => f.path === outgoing)) {
      states.set(outgoing, view.state);
      scrolls.set(outgoing, view.scrollSnapshot());
    }

    const activePath = wsState?.activePath ?? null;
    const file = activePath
      ? openFiles.find((f) => f.path === activePath)
      : undefined;
    if (!file) {
      if (outgoing !== null) view.setState(createBlankState());
      activePathRef.current = null;
      return;
    }

    let state = stateOf(file.path);
    if (
      !state ||
      state.readOnly !== !!(file.readOnly || file.refused) ||
      state.sliceDoc() !== file.content
    ) {
      state = createFileState(file);
      scrolls.delete(file.path);
    }
    const wantTheme = editorTheme(themeRef.current);
    const wantWrap = effectiveWrap(file.path) ? WRAP_ON : WRAP_OFF;
    const effects: StateEffect<unknown>[] = [];
    if (themeComp.get(state) !== wantTheme) effects.push(themeComp.reconfigure(wantTheme));
    if (wrapComp.get(state) !== wantWrap) effects.push(wrapComp.reconfigure(wantWrap));
    const wantGutter = gutterExt();
    if (gutterComp.get(state) !== wantGutter) effects.push(gutterComp.reconfigure(wantGutter));
    const wantIndent = indentFor(tabSizeRef.current, state.facet(INDENT_TABS));
    if (indentComp.get(state) !== wantIndent) effects.push(indentComp.reconfigure(wantIndent));
    if (effects.length > 0) state = state.update({ effects }).state;
    states.set(file.path, state);

    activePathRef.current = file.path;
    if (state !== view.state) {
      view.setState(state);
      const scroll = scrolls.get(file.path);
      if (scroll) view.dispatch({ effects: scroll });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsState?.activePath, activeFile?.loadId]);

  // GH #170: a closed tab's state goes with it, so memory is bounded by the
  // tabs that are open. (A file reopened later starts a new history.)
  const openPaths = wsState?.openFiles.map((f) => f.path).join("\0") ?? "";
  useEffect(() => {
    const open = new Set(openPaths ? openPaths.split("\0") : []);
    for (const path of [...statesRef.current.keys()]) {
      if (!open.has(path)) {
        statesRef.current.delete(path);
        scrollRef.current.delete(path);
      }
    }
  }, [openPaths]);

  // Live-react to theme changes: the state that is showing now; a stored state
  // is brought up to date when it is switched back in (above).
  useEffect(() => {
    const view = viewRef.current;
    const themeComp = themeCompRef.current;
    if (!view || !themeComp) return;
    view.dispatch({
      effects: themeComp.reconfigure(editorTheme(theme)),
    });
  }, [theme]);

  // Live-react to wrap changes: per-file toggle, or the global editor.wordWrap
  // setting — on the state that is showing. A switch applies the incoming file's
  // wrap itself (above).
  useEffect(() => {
    const view = viewRef.current;
    const wrapComp = wrapCompRef.current;
    const path = activePathRef.current;
    if (!view || !wrapComp || !path) return;
    const want = effectiveWrap(path) ? WRAP_ON : WRAP_OFF;
    if (wrapComp.get(view.state) === want) return;
    view.dispatch({ effects: wrapComp.reconfigure(want) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsState?.activePath, wrapByPath, wordWrap]);

  // GH #205: live-react to Settings › Code › Line numbers and Tab size — a
  // reconfigure of the state that is showing, never a new view: the container
  // and its `.cm-editor` stay the ones mounted once. A stored state catches up
  // when it is switched back in (the swap effect above); the blank state
  // follows too, so the next file opened into it starts right.
  useEffect(() => {
    const view = viewRef.current;
    const gutterComp = gutterCompRef.current;
    const indentComp = indentCompRef.current;
    if (!view || !gutterComp || !indentComp) return;
    const wantGutter = gutterExt();
    const wantIndent = indentFor(tabSize, view.state.facet(INDENT_TABS));
    const effects: StateEffect<unknown>[] = [];
    if (gutterComp.get(view.state) !== wantGutter) effects.push(gutterComp.reconfigure(wantGutter));
    if (indentComp.get(view.state) !== wantIndent) effects.push(indentComp.reconfigure(wantIndent));
    if (effects.length > 0) view.dispatch({ effects });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showLineNumbers, tabSize]);

  /**
   * GH #170: replace one file's document with what is on disk, **in that file's
   * own state** — the view's, when it is the one showing, or the stored one —
   * and only then tell the store.
   *
   * Deliberately undoable (GH #142 review 2): this is what the prompt's "your
   * unsaved edits will be lost" warns about, and ⌘Z is the member's way back to
   * them. It enters only this file's history, so no other tab can ⌘Z into it.
   * The state is updated first, so that when the store's `loadId` bump re-runs
   * the swap effect, the state already holds the store's bytes and is kept —
   * history and all — rather than rebuilt. A file that was never shown has no
   * state yet; it gets one from the store's bytes when it is.
   *
   * `RELOAD` makes it an undo step of its own: typed within the history's
   * grouping window of a keystroke, it would otherwise merge with that typing,
   * and one ⌘Z would go past the member's edits to before them.
   */
  function reloadIntoOwnState(path: string, content: string) {
    const view = viewRef.current;
    let own = stateOf(path);
    // The file's line ends changed (LF ↔ CRLF): its state reads them its own
    // way, so the swap effect builds a new one from the store's bytes.
    if (own && (own.lineBreak === "\r\n") !== usesCrlf(content)) {
      statesRef.current.delete(path);
      own = undefined;
    }
    if (view && own && own === view.state) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: content },
        annotations: RELOAD,
      });
    } else if (own) {
      statesRef.current.set(
        path,
        own.update({
          changes: { from: 0, to: own.doc.length, insert: content },
          annotations: RELOAD,
        }).state,
      );
    }
    replaceFromDisk(workspaceId, path, content);
  }

  // GH #138: a file dropped on the editor opens it.
  //
  // This is the behaviour the card's Tier 4 asks for, and until now nothing
  // implemented it: the `atelier:window-drop` listener below has been dead
  // since Hard Rule #6, and CodeMirror's own `drop` handler reads a dropped
  // file and *inserts its text* — for an image, binary noise in the open
  // document. The host listens in the **capture** phase so it takes the drop
  // before CodeMirror sees it, and only for the kinds the editor's
  // `data-drop-accepts` marker declares. A plain text drag is not one of
  // them, so dragging text inside the editor still moves it.
  //
  // An external drop has no path in the webview, and Tauri's own drop events
  // (`onDragDropEvent`) need the window's drop handler, which Hard rule 6
  // keeps off. QoL 6.4 (E10): so the bytes go to `fs_open_dropped`, which
  // finds the same file in the workspace (name, size and bytes) and opens
  // **that file** — ⌘S saves the real one. A file from outside the project
  // opens as a read-only copy, with Copy into the project beside its line,
  // never as a writable copy whose saves would silently miss the original.
  // A file that is not text fails `fs_read_text_file` and says so.
  useEffect(() => {
    const host = dropHostRef.current;
    if (!host) return;
    async function openPath(workspaceId: string, path: string, outside = false) {
      try {
        const content = await invoke<string>("fs_read_text_file", { path });
        // The workspace is the one the drop landed in, captured before the
        // await: switching workspaces mid-read must not open the file into
        // whichever one is active by the time the bytes arrive.
        useEditor
          .getState()
          .open(workspaceId, path, content, outside ? { place: "outside", line: OUTSIDE_LINE } : null);
      } catch (err) {
        // UX-8.5: a file the editor cannot show as text opens its page.
        const refusal = fileRefusal(err);
        if (refusal) {
          useEditor.getState().openRefused(workspaceId, path, refusal);
          return;
        }
        pushToast({
          kind: "error",
          title: "Cannot open dropped file",
          // A refused drop (GH #230) says why in words; anything else is raw.
          body: err instanceof Error ? err.message : path,
          details: err instanceof Error ? undefined : rawError(err),
        });
      }
    }
    function onHostDrop(event: Event) {
      const e = event as DragEvent;
      if (!acceptsDrag(e, EDITOR_DROP_KINDS)) return;
      const dt = e.dataTransfer;
      if (!dt) return;
      e.preventDefault();
      e.stopPropagation();
      const droppedInto = workspaceIdRef.current;
      const internalPath = dt.getData("application/x-atelier-path");
      if (internalPath) {
        void openPath(droppedInto, internalPath);
        return;
      }
      const files = dt.files ? Array.from(dt.files) : [];
      void (async () => {
        const refused: DropRefusal[] = [];
        let opened = 0;
        for (const file of files) {
          try {
            // Refuse before materializing: see `droppedFileRejection`.
            const head = new Uint8Array(
              await file.slice(0, BINARY_SNIFF_BYTES).arrayBuffer(),
            );
            const rejection = droppedFileRejection(file, head);
            if (rejection) {
              // Challenger round 1: said with the drop's other refusals,
              // one toast for the drop.
              refused.push({ name: file.name, error: new DropRefusedError(rejection) });
              continue;
            }
            // GH #230: read whole, or refused as incomplete — never a prefix.
            // Challenger D1: a big project takes a moment to search; say so
            // after 300 ms rather than look stuck.
            let looking: string | null = null;
            const lookingTimer = setTimeout(() => {
              looking = pushToast({ kind: "info", title: "Looking for this file in the project…", ttlMs: 60_000 });
            }, 300);
            let dropped;
            try {
              dropped = await openDroppedFile(droppedInto, file);
            } finally {
              clearTimeout(lookingTimer);
              if (looking) dismissToast(looking);
            }
            await openPath(droppedInto, dropped.path, !dropped.inside);
            opened++;
            if (dropped.inside) {
              // Which file of the project it took the drop for, in one line.
              const cwd = useWorkspaces.getState().workspaces.find((w) => w.id === droppedInto)?.cwd ?? null;
              const shown = relativeToWorkspace(dropped.path, cwd) ?? basename(dropped.path);
              pushToast({ kind: "info", title: `Opened ${shown} from this project` });
            }
          } catch (err) {
            refused.push({ name: file.name, error: err });
          }
        }
        // 1.172.2 D2: one toast for the drop, in plain words; the raw
        // reason behind Details.
        toastDropRefusals(refused, "editor", opened);
      })();
    }
    function onHostDragOver(event: Event) {
      const e = event as DragEvent;
      if (!acceptsDrag(e, EDITOR_DROP_KINDS)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    }
    host.addEventListener("dragover", onHostDragOver, true);
    host.addEventListener("drop", onHostDrop, true);
    return () => {
      host.removeEventListener("dragover", onHostDragOver, true);
      host.removeEventListener("drop", onHostDrop, true);
    };
  }, []);

  // Legacy: Tauri's native drag-drop bridge. Dead under Hard Rule #6 — kept
  // harmless in case the window flag is ever enabled selectively.
  useEffect(() => {
    function onDrop(e: Event) {
      const detail = (e as CustomEvent).detail as {
        paths: string[];
        x: number;
        y: number;
      };
      const node = containerRef.current;
      if (!node) return;
      // Skip if this workspace's host is hidden
      const host = node.closest(".workspace-host");
      if (host && host.classList.contains("hidden")) return;
      const r = node.getBoundingClientRect();
      if (
        detail.x < r.left ||
        detail.x > r.right ||
        detail.y < r.top ||
        detail.y > r.bottom
      ) {
        return;
      }
      (async () => {
        for (const path of detail.paths) {
          try {
            const content = await invoke<string>("fs_read_text_file", { path });
            useEditor.getState().open(workspaceIdRef.current, path, content);
          } catch (err) {
            pushToast({
              kind: "error",
              title: "Cannot open dropped file",
              // A refused drop (GH #230) says why in words; anything else is raw.
              body: err instanceof Error ? err.message : path,
              details: err instanceof Error ? undefined : rawError(err),
            });
          }
        }
      })();
    }
    window.addEventListener("atelier:window-drop", onDrop);
    return () => window.removeEventListener("atelier:window-drop", onDrop);
  }, []);

  // Jump to a line when search results are clicked
  useEffect(() => {
    function onGoto(e: Event) {
      const detail = (e as CustomEvent).detail as {
        workspaceId: string;
        path: string;
        line: number;
        /** QoL 3.4 (E9): the match's columns in the line, when it has one. */
        from?: number;
        to?: number;
        /** The In files search, for ⌘G to step through with its options. */
        find?: { search: string; caseSensitive: boolean; regexp: boolean; wholeWord: boolean };
        /** QoL 1.168 (D6): a terminal link's column, 1-based. */
        col?: number;
      };
      if (detail.workspaceId !== workspaceId) return;
      if (detail.path !== activePathRef.current) return;
      const view = viewRef.current;
      if (!view) return;
      const lineNumber = Math.max(1, Math.min(view.state.doc.lines, detail.line));
      const line = view.state.doc.line(lineNumber);
      const at = (col: number | undefined) =>
        col === undefined ? line.from : Math.min(line.to, line.from + Math.max(0, col));
      // A terminal link (D6) gives a 1-based column; an In files match (E9)
      // its from/to.
      const anchor =
        detail.from === undefined && detail.col !== undefined
          ? line.from + Math.max(0, Math.min(line.length, detail.col - 1))
          : at(detail.from);
      const head = detail.from === undefined ? anchor : Math.max(anchor, at(detail.to ?? detail.from));
      const matched = view.state.sliceDoc(anchor, head);
      view.dispatch({
        selection: { anchor, head },
        effects: [
          EditorView.scrollIntoView(anchor, { y: "center" }),
          // ⌘G / ⇧⌘G step to the next and previous place the same text is.
          ...(detail.find
            ? [
                setSearchQuery.of(
                  new SearchQuery({
                    search: detail.find.search,
                    caseSensitive: detail.find.caseSensitive,
                    regexp: detail.find.regexp,
                    wholeWord: detail.find.wholeWord,
                    literal: !detail.find.regexp,
                  }),
                ),
              ]
            : matched && !matched.includes("\n")
              ? [setSearchQuery.of(new SearchQuery({ search: matched, caseSensitive: true, literal: true }))]
              : []),
        ],
      });
      view.focus();
    }
    window.addEventListener("atelier:goto-line", onGoto);
    return () => window.removeEventListener("atelier:goto-line", onGoto);
  }, [workspaceId]);

  // External-write reload subscription
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    // Challenger D2: the reads are async and may finish out of order. Each
    // change to a file is numbered, and a read that finishes after a newer
    // one was started is dropped — a clean tab never ends on the older
    // bytes (which a later ⌘S would write over the newer ones).
    const latest = new Map<string, number>();
    let counter = 0;

    onFileChange(async (e) => {
      if (e.workspaceId !== workspaceId) return;
      const ws = useEditor.getState().byWorkspace[workspaceId];
      // One tab per file however it was spelled (Windows: either separator, any
      // case); every call below uses the tab's own path.
      const file = ws?.openFiles.find((f) => samePath(f.path, e.path));
      // UX-8.5: a file Code could not open has no text to reload.
      if (!file || file.refused) return;
      const path = file.path;
      const name = basename(path);
      const key = pathKey(path);
      const mine = ++counter;
      latest.set(key, mine);

      if (e.kind === "removed") {
        markRemoved(workspaceId, path, true);
        pushToast({
          kind: "warn",
          title: `${name} was removed externally`,
          // GH #142: a reading view has no ⌘S to offer, so it is not offered one.
          body: file.readOnly
            ? "The copy Plyloft was reading is gone; this tab is what is left of it."
            : `Save (${SAVE_KEYS}) to recreate it.`,
        });
        return;
      }
      if (e.kind === "created") {
        markRemoved(workspaceId, path, false);
        return;
      }
      // modified
      try {
        const diskContent = await invoke<string>("fs_read_text_file", {
          path,
        });
        if (cancelled || latest.get(key) !== mine) return;
        setDiskNotText(path, false);
        // Nothing changed for this tab: the disk holds exactly what it shows.
        // That is the write Plyloft itself just made (New skill writes the
        // file, then opens it; the watcher reports the write after the tab
        // already has those bytes) or a touch that changed no byte — neither
        // is news, so no reload and no "changed externally" notice.
        const current = useEditor
          .getState()
          .byWorkspace[workspaceId]?.openFiles.find((f) => samePath(f.path, path));
        if (current && current.content === diskContent) return;
        // GH #142: a read-only copy is never dirty and is never asked about.
        // Both answers of that question are about a write — "reload and lose your
        // edits" or "keep mine, and ⌘S overwrites the disk" — and a reading view
        // has neither, so it simply follows the file it is reading.
        const dirty = isFileDirty(file);
        const promptDirty =
          !file.readOnly && reloadStrategy !== "alwaysReload" && dirty;
        const promptAlways =
          !file.readOnly && reloadStrategy === "alwaysPrompt" && !dirty;
        if (promptDirty || promptAlways) {
          setPendingExternal({ path, name, diskContent });
        } else {
          // QoL 6.2 (part of A2): a clean file follows the disk without a
          // word — an AI writing App.tsx ten times is not ten toasts, nor one
          // in a workspace out of sight. The reload is still one undo step.
          reloadIntoOwnState(path, diskContent);
          markUpdated(path);
        }
      } catch (err) {
        // Windows re-check of block 6: a file that is no longer text (UTF-16
        // appended by PowerShell 5.1, a binary written over it) is said on
        // the tab; anything else (a moment mid-rename) is still let pass.
        if (!cancelled && latest.get(key) === mine && fileRefusal(err)) setDiskNotText(path, true);
      }
    })
      .then((u) => {
        if (cancelled) u();
        else unlisten = u;
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [workspaceId, replaceFromDisk, markRemoved, reloadStrategy]);

  /** Reload on the "isn't plain text any more" notice: the text if it is
   *  text again, else the tab's "can't open this file here" page. */
  async function reloadNotText(path: string) {
    try {
      const content = await invoke<string>("fs_read_text_file", { path });
      setDiskNotText(path, false);
      reloadIntoOwnState(path, content);
    } catch (e) {
      const refusal = fileRefusal(e);
      if (!refusal) return;
      setDiskNotText(path, false);
      useEditor.getState().openRefused(workspaceId, path, refusal);
    }
  }

  /** QoL 6.4: the read-only copy at `copyPath` into the workspace folder,
   *  then opened there in its place. */
  async function copyIntoProject(copyPath: string) {
    try {
      const made = await fsCopyIntoWorkspace(workspaceId, copyPath, basename(copyPath));
      useEditor.getState().close(workspaceId, copyPath);
      await openInEditor(workspaceId, made);
    } catch (e) {
      pushErrorToast(`${basename(copyPath)} wasn't copied into the project`, e);
    }
  }

  return (
    <div className="editor-panel">
      {hasFiles && (
        <div className="editor-tabs">
          {wsState!.openFiles.map((f) => {
            const dirty = isFileDirty(f);
            const name = basename(f.path);
            const isActive = f.path === wsState!.activePath;
            const removed = !!f.removedExternally;
            // GH #142: the tab says it too. The banner is only above the file
            // that is showing, and a member with four tabs open has to be able
            // to tell which of them are reading views before they click.
            const reading = !!f.readOnly;
            const refused = !!f.refused;
            const notSaved = f.path in saveFailures;
            return (
              <div
                key={f.path}
                className={`editor-tab${isActive ? " active" : ""}${removed ? " removed" : ""}${reading ? " read-only" : ""}${refused ? " refused" : ""}${notSaved ? " not-saved" : ""}`}
                onClick={() => setActive(workspaceId, f.path)}
                title={
                  reading
                    ? `${f.path} (${READ_ONLY_TAB} — ${f.readOnly!.line})`
                    : removed
                      ? `${f.path} (removed externally — ${SAVE_KEYS} to recreate)`
                      : notSaved
                        ? `${f.path} (not saved — ${SAVE_KEYS} to try again)`
                        : f.path
                }
              >
                {dirty && <span className="dirty-dot" />}
                <span className="tab-name">{name}</span>
                {reading && <span className="tab-readonly">{READ_ONLY_TAB}</span>}
                {notSaved && <span className="tab-not-saved">Not saved</span>}
                {!notSaved && f.path in updated && <span className="tab-updated">Updated</span>}
                {notText[f.path] && <span className="tab-not-saved">Not text on disk</span>}
                <button
                  type="button"
                  className="tab-close"
                  aria-label={`Close ${name}`}
                  title="Close"
                  onClick={(e) => {
                    e.stopPropagation();
                    // QoL 1.168 S1-1/E5: the one close path, ⌘W's too —
                    // a dirty tab asks Save and close / Don't save / Cancel.
                    void closeEditorTab(workspaceId, f.path);
                  }}
                >
                  <Icon name="close" size="sm" />
                </button>
              </div>
            );
          })}
        </div>
      )}
      {/* GH #142: where this copy lives, and why Code cannot write it. Above the
          document and under the tabs, so it is read before the first keystroke
          rather than after it — and only for the file that is showing. */}
      {readOnly && (
        <div className="editor-readonly-banner" role="status">
          {readOnly.line}
          {/* QoL 6.4: a dropped file from outside the project becomes an
              ordinary, writable file of it — a copy, never over a file. */}
          {readOnly.place === "outside" && activeFile && (
            <CBtn size="sm" onClick={() => void copyIntoProject(activeFile.path)}>
              {COPY_INTO_PROJECT}
            </CBtn>
          )}
        </div>
      )}
      {/* F1 (1.172.1): after "I don't work here", a file of the project
          folder says which version it is. */}
      {activeFile && <FolderVersionLine workspaceId={workspaceId} where={activeFile.path} file />}
      {/* Windows re-check of block 6: the file on disk stopped being text. */}
      {activeFile && notText[activeFile.path] && (
        <div className="editor-disk-notice" role="alert">
          <span>{notTextLine(basename(activeFile.path))}</span>
          <CBtn size="sm" onClick={() => void reloadNotText(activeFile.path)}>
            Reload
          </CBtn>
          <CBtn
            size="sm"
            onClick={() => {
              // The tab's own close: asks first when it has unsaved changes.
              const path = activeFile.path;
              void closeEditorTab(workspaceId, path).then((closed) => {
                if (closed) setDiskNotText(path, false);
              });
            }}
          >
            Close
          </CBtn>
        </div>
      )}
      {/* GH #308: a failed save is said where the file is — under the tabs,
          words first, the raw error behind Details. */}
      {activeFile && activeFile.path in saveFailures && (
        <div className="editor-save-error">
          <ErrorBlock
            density="dense"
            error={saveFailedError(
              basename(activeFile.path),
              saveFailures[activeFile.path],
            )}
            onAction={() =>
              setSaveFailures(({ [activeFile.path]: _gone, ...rest }) => rest)
            }
          />
        </div>
      )}
      <div
        className="editor-content"
        ref={dropHostRef}
        // GH #138: the editor opens a dropped file. The whole content area is
        // the zone — the Markdown preview and the empty state are the editor
        // too — while CodeMirror's content inside keeps its own text drops
        // (`CODEMIRROR_KINDS`), because the nearest accepting zone wins.
        data-drop-zone="editor"
        data-drop-accepts={acceptsAttr(EDITOR_DROP_KINDS)}
      >
        <div
          ref={containerRef}
          className={`editor-host${showingPreview ? " editor-host-hidden" : ""}`}
          style={{ "--ply-editor-text-size": `${editorTextPx}px` } as CSSProperties}
        />
        {showingPreview && (
          <div
            className="editor-md-preview"
            dangerouslySetInnerHTML={{ __html: previewHtml }}
          />
        )}
        {/* v1.83.0 (Part 2 P2-5, Q5): the v1.20 telemetry dashboard is
            RETIRED — the empty state is an opener; telemetry → Activity. */}
        {/* UX-8.5: a file Code cannot open as text gets a page in its tab.
            An overlay, so the editor's container stays mounted beneath. */}
        {refused && activeFile && (
          <RefusedFilePage
            workspaceId={workspaceId}
            path={activeFile.path}
            reason={refused.reason}
          />
        )}
        {!hasFiles && (
          <div className="editor-dashboard-overlay">
            <CodeOpener workspaceId={workspaceId} />
          </div>
        )}
      </div>
      {/* GH #267: one line under the document, only what is useful — no
          path (the header's breadcrumb names the file, its tooltip the
          absolute path), "Unsaved changes" only while there are some, and
          nothing at all for a file Code could not open (its page says so). */}
      {activeFile && !refused && (
        <div className="editor-statusbar">
          <span className="editor-statusbar-state">
            {readOnly
              ? READ_ONLY_TAB
              : isFileDirty(activeFile)
                ? `Unsaved changes · ${SAVE_KEYS}`
                : null}
          </span>
          <span className="editor-statusbar-actions">
            {!showingPreview && (
              <button
                type="button"
                className="editor-statusbar-btn"
                aria-pressed={activeWrap}
                onClick={() =>
                  setWrapByPath((p) => ({
                    ...p,
                    [activeFile.path]: !effectiveWrap(activeFile.path),
                  }))
                }
                title="Wrap long lines in this file (Markdown wraps by default)"
              >
                Wrap
              </button>
            )}
          </span>
        </div>
      )}
      {pendingExternal && (
        <ConfirmDialog
          title={`${pendingExternal.name} changed on disk`}
          body={`Reload the file (your unsaved edits will be lost) or keep your version (${SAVE_KEYS} will overwrite the disk)?`}
          confirmLabel="Reload from disk"
          cancelLabel="Keep mine"
          destructive
          onConfirm={() => {
            // Undoable, in this file's own history: ⌘Z is the way back to the
            // edits this prompt says will be lost.
            reloadIntoOwnState(pendingExternal.path, pendingExternal.diskContent);
            setPendingExternal(null);
          }}
          onCancel={() => setPendingExternal(null)}
        />
      )}
    </div>
  );
}

/**
 * UX-8.5: the page a tab shows for a file Code cannot open as text (binary,
 * over 5 MB, not UTF-8): what happened, why in words, and Reveal in Finder.
 */
export function RefusedFilePage({
  workspaceId,
  path,
  reason,
}: {
  workspaceId: string;
  path: string;
  reason: string;
}) {
  const cwd = useWorkspaces(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.cwd ?? null,
  );
  const shown = relativeToWorkspace(path, cwd) ?? path;
  /** GH #308: a Reveal that failed, said on this page; its raw error goes
   *  only to the block's Details. */
  const [revealErrorDetails, setRevealErrorDetails] = useState<string | null>(null);
  return (
    <section className="editor-refused" aria-labelledby="editor-refused-title">
      <div className="editor-refused-inner">
        <h2 id="editor-refused-title" className="editor-refused-title">
          Plyloft can't open this file here
        </h2>
        <p className="editor-refused-reason">{reason}</p>
        <p className="editor-refused-path" title={path}>
          {shown}
        </p>
        <div className="editor-refused-actions">
          <CBtn
            onClick={() => {
              setRevealErrorDetails(null);
              fsRevealInWorkspace(workspaceId, path).catch((e) => setRevealErrorDetails(rawError(e)));
            }}
          >
            <Icon name="reveal" />
            {platformWord("reveal")}
          </CBtn>
        </div>
        {revealErrorDetails !== null && (
          <ErrorBlock
            density="dense"
            error={revealFailedError(revealErrorDetails)}
            onAction={() => setRevealErrorDetails(null)}
          />
        )}
      </div>
    </section>
  );
}
