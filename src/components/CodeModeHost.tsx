import { EditorTabContent } from "./EditorTabContent";
import { BrowserPane } from "./BrowserPane";
import { ModeHeader } from "./ModeHeader";
import { MoreMenu } from "./ux";
import { CBtn } from "./ui/primitives";
import { useEditor } from "../store/editorStore";
import { openCodePreview, useUi } from "../store/uiStore";
import { useTryRuns } from "../store/tryRunStore";
import { useKanban } from "../store/kanbanStore";
import { useWorkspaces } from "../store/workspaceStore";
import { tryPreviewChoices } from "../lib/tryProject";
import { laneOf, laneVendorName } from "../lib/buildBoth";
import type { KanbanCard } from "../ipc";
import { ProjectTryStrip } from "./ProjectTryStrip";
import { useMarkdownPreview } from "../store/markdownPreviewStore";
import { isMarkdownPath } from "../lib/markdownPath";
import { pathCrumbs } from "../lib/workspacePath";
import { useSettings } from "../store/settingsStore";
import { shortcutKeys } from "../lib/shortcuts";
import { FILES_NEW_EVENT, type FilesNewDetail } from "./FilesPanel";
import "./code.css";

/**
 * v1.67.0 (UX revamp step 3a): the Code stage mode — Files + editor
 * (the right panel's exact `EditorTabContent`, re-hosted center-stage)
 * plus the localhost Preview strip (decision card #3: the preview orphan
 * homes "where you're editing the thing it renders"). The single-editor
 * rule holds because this host is the editor's only render site: one per
 * warmed workspace, mounted the first time that workspace opens Code and
 * then kept, CSS-hidden, across mode flips and workspace switches (GH #95,
 * `stickyHosts` in NewWorkspaceShell) so the EditorView keeps its undo
 * history. Never mount it on `centerMode === "code"` alone.
 */
const NO_CARDS: KanbanCard[] = [];

export function CodeModeHost({
  workspaceId,
  cwd,
}: {
  workspaceId: string;
  cwd: string;
}) {
  // Try it TI-3: the strip's state is in useUi (per workspace, session-only)
  // so `openCodePreview` can open it on a found address from outside.
  const previewOpen = useUi((s) => Boolean(s.codePreviewOpen[workspaceId]));
  const previewTarget = useUi((s) => s.codePreviewTarget[workspaceId] ?? null);
  const setPreviewOpen = useUi((s) => s.setCodePreviewOpen);
  // UX-8.5: the header names the open file — its folders in the breadcrumb,
  // relative to the workspace, and its name as the title; the absolute path
  // is the title's tooltip only.
  const activePath = useEditor((s) => s.byWorkspace[workspaceId]?.activePath ?? null);
  const crumbs = activePath ? pathCrumbs(activePath, cwd) : null;
  // GH #268: the header's one action is the open Markdown file's Preview —
  // shown only when there is one to preview. The localhost preview is a
  // separate tool, named as such in the ⋯.
  const activeFile = useEditor((s) =>
    activePath
      ? s.byWorkspace[workspaceId]?.openFiles.find((f) => f.path === activePath) ?? null
      : null,
  );
  const markdown =
    activeFile && !activeFile.refused && isMarkdownPath(activeFile.path) ? activeFile : null;
  const previewing = useMarkdownPreview((s) =>
    markdown ? Boolean(s.on[workspaceId]?.[markdown.path]) : false,
  );
  const togglePreview = useMarkdownPreview((s) => s.toggle);

  return (
    <div className="code-mode-host">
      <div className="code-mode-main">
        {/* UX-3.5: the screen header. GH #268: its one action is the
            Markdown Preview (a .md file open); Go to file (⌘P) and your
            running app sit in the ⋯. */}
        <ModeHeader
          mode="code"
          workspaceId={workspaceId}
          trail={crumbs?.folders}
          title={
            crumbs ? (
              <span title={activePath ?? undefined}>
                {crumbs.name}
              </span>
            ) : undefined
          }
          actions={
            <>
              {markdown && (
                <CBtn
                  onClick={() => togglePreview(workspaceId, markdown.path)}
                  title={previewing ? "Show the file's text" : "Show this file rendered"}
                >
                  {/* GH #142: `Edit` would be a promise a reading view cannot
                      keep — the other half of this toggle there is the file's
                      own text. */}
                  {previewing ? (markdown.readOnly ? "Source" : "Edit") : "Preview"}
                </CBtn>
              )}
              <CodeMoreMenu
                workspaceId={workspaceId}
                previewOpen={previewOpen}
                onTogglePreview={() => setPreviewOpen(workspaceId, !previewOpen)}
              />
            </>
          }
        />
        <div className="code-mode-editor">
          <EditorTabContent workspaceId={workspaceId} cwd={cwd} />
        </div>
      </div>
      {previewOpen && (
        <div className="code-mode-preview">
          <ProjectTryStrip workspaceId={workspaceId} />
          {/* Keyed on the target: a new found address boots the pane on it.
              Only the strip remounts; the editor above never does. */}
          <BrowserPane
            key={previewTarget ? `${previewTarget.address}#${previewTarget.nonce}` : ""}
            workspaceId={workspaceId}
            initialAddress={previewTarget?.address ?? null}
          />
        </div>
      )}
    </div>
  );
}

/** QoL 6.3: asks the workspace's tree for a new file or folder at its top. */
function newInTree(workspaceId: string, kind: FilesNewDetail["kind"]) {
  window.dispatchEvent(
    new CustomEvent<FilesNewDetail>(FILES_NEW_EVENT, { detail: { workspaceId, kind } }),
  );
}

/**
 * Code's ⋯. Try it TI-5: before *Show localhost preview*, each running Try
 * session of this workspace — the project's, then the cards' by title —
 * opens the strip on its address. Its own component: the Try sessions'
 * runs change as their output arrives, and only this menu reads them, so
 * the editor's host never re-renders for it.
 */
function CodeMoreMenu({
  workspaceId,
  previewOpen,
  onTogglePreview,
}: {
  workspaceId: string;
  previewOpen: boolean;
  onTogglePreview: () => void;
}) {
  const tryRuns = useTryRuns((s) => s.runs);
  const showHidden = useSettings((s) => s.settings.editor.showHiddenFiles);
  const cards = useKanban((s) => s.byWorkspace[workspaceId]?.cards ?? NO_CARDS);
  const projectName = useWorkspaces((s) => s.workspaces.find((w) => w.id === workspaceId)?.name ?? "");
  const tryChoices = tryPreviewChoices(tryRuns, workspaceId, projectName, (cardId, lane) => {
    const card = cards.find((c) => c.id === cardId);
    if (!card) return null;
    if (!lane || !card.buildBoth) return card.title;
    const id = lane === "b" ? "b" : "a";
    return `${card.title} (${laneVendorName(laneOf(card.buildBoth, id), id)})`;
  });
  return (
    <MoreMenu
      label="More for Code"
      tour="code-more"
      items={[
        {
          // 1.174.0 E10 (T12): one name for it, with its key.
          label: "Go to file…",
          shortcut: shortcutKeys("files"),
          onSelect: () => window.dispatchEvent(new Event("ply:open-quickopen")),
        },
        // QoL 6.3: a new file or folder at the top of the project; a row's
        // right-click makes one inside a folder.
        { label: "New file", onSelect: () => newInTree(workspaceId, "file") },
        { label: "New folder", onSelect: () => newInTree(workspaceId, "folder") },
        // QoL 6.1 (D12): the same switch as Settings › Code.
        {
          label: "Show hidden files",
          toggle: true,
          checked: showHidden,
          onSelect: () =>
            void useSettings.getState().update((cur) => ({
              ...cur,
              editor: { ...cur.editor, showHiddenFiles: !cur.editor.showHiddenFiles },
            })),
        },
        ...tryChoices.map((c) => ({
          label: c.label,
          onSelect: () => void openCodePreview(workspaceId, c.address),
        })),
        {
          // E10 (T13): the address stays in the preview's strip.
          label: previewOpen ? "Hide your running app" : "Show your running app",
          onSelect: onTogglePreview,
        },
      ]}
    />
  );
}
