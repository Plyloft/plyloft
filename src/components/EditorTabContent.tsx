import { useEffect, useRef } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { invoke } from "@tauri-apps/api/core";
import { FilesPanel } from "./FilesPanel";
import { EditorPanel } from "./EditorPanel";
import { CodeownersRibbon } from "./CodeownersRibbon";
import { useWorkspaces } from "../store/workspaceStore";
import { useEditor } from "../store/editorStore";
import { openInEditor } from "../lib/openInEditor";
import { fileRefusal } from "../lib/fileRefusal";

/** v1.67.0 (UX revamp step 3a): Code mode hosts this component in the
 *  center stage (`CodeModeHost`). GH #95: it used to live in RightTabs.tsx;
 *  the right panel is retired, so this is its only render site — two live
 *  CodeMirror views on one file would silently diverge (the editor pushes
 *  to the store on change but only pulls on tab switch). */
export function EditorTabContent({
  workspaceId,
  cwd,
}: {
  workspaceId: string;
  cwd: string;
}) {
  const restoredRef = useRef(false);

  // UX-8.5: a file Code cannot open as text opens a page in its tab.
  async function openFile(path: string) {
    await openInEditor(workspaceId, path);
  }

  // Restore persisted open files once per workspace lifetime.
  useEffect(() => {
    if (restoredRef.current) return;
    const ws = useWorkspaces.getState().workspaces.find((w) => w.id === workspaceId);
    if (!ws) return;
    const editorState = useEditor.getState().byWorkspace[workspaceId];
    if (editorState && editorState.openFiles.length > 0) {
      restoredRef.current = true;
      return;
    }
    const persisted = ws.openFiles ?? [];
    if (persisted.length === 0) {
      restoredRef.current = true;
      return;
    }
    restoredRef.current = true;
    (async () => {
      for (const path of persisted) {
        try {
          const content = await invoke<string>("fs_read_text_file", { path });
          useEditor.getState().open(workspaceId, path, content);
        } catch (e) {
          // UX-8.5: still one Code cannot open as text — its page again.
          const refusal = fileRefusal(e);
          if (refusal) useEditor.getState().openRefused(workspaceId, path, refusal);
          else console.warn(`Could not restore ${path}:`, e);
        }
      }
      const restoredActive = ws.activeFile;
      if (restoredActive && persisted.includes(restoredActive)) {
        useEditor.getState().setActive(workspaceId, restoredActive);
      }
    })();
  }, [workspaceId]);

  // Persist open files (debounced) on changes.
  //
  // GH #142: a read-only tab is **not** persisted. The workspace stores paths
  // alone (`Workspace.openFiles: string[]`), and the restore above reopens each
  // of them through the ordinary writable path — so persisting the mirror's or
  // this Mac's copy would hand it back as an editable tab after a restart, which
  // is the one thing this card exists to prevent. A reading view is opened from
  // the Library, and that is where it is opened again.
  useEffect(() => {
    let timer: number | null = null;
    let lastSig = "";
    const unsub = useEditor.subscribe((state) => {
      const ws = state.byWorkspace[workspaceId];
      if (!ws) return;
      // UX-8.5: a tab showing the "can't open here" page is kept, and the
      // restore above opens it as that page again.
      const kept = ws.openFiles.filter((f) => !f.readOnly);
      const active =
        ws.activePath && kept.some((f) => f.path === ws.activePath)
          ? ws.activePath
          : null;
      const sig = kept.map((f) => f.path).join("\n") + "|" + (active ?? "");
      if (sig === lastSig) return;
      lastSig = sig;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        useWorkspaces
          .getState()
          .setFiles(workspaceId, kept.map((f) => f.path), active)
          .catch(console.error);
      }, 500);
    });
    return () => {
      unsub();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [workspaceId]);

  return (
    <PanelGroup
      direction="horizontal"
      autoSaveId={`atelier-right-editor-${workspaceId}`}
      className="right-editor-panels"
    >
      <Panel defaultSize={32} minSize={20} maxSize={60}>
        <FilesPanel workspaceId={workspaceId} cwd={cwd} onOpen={openFile} />
      </Panel>
      <PanelResizeHandle className="resize-handle resize-h" />
      <Panel defaultSize={68}>
        <div className="editor-pane-stack">
          <CodeownersRibbon workspaceId={workspaceId} />
          <div className="editor-pane-body">
            <EditorPanel workspaceId={workspaceId} />
          </div>
        </div>
      </Panel>
    </PanelGroup>
  );
}
