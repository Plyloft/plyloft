/**
 * QoL 1.168 (S1-1, S1-2, E4): saving an open file from outside its editor —
 * the quit sheet's Save all, Code's Save all and the tab's Save and close.
 *
 * The store holds every open file's current text (the editor writes each
 * change into it), so a file can be saved whichever workspace it is in and
 * whether or not its editor is on screen. The write is the same one ⌘S makes
 * (`fs_write_text_file`), then the baseline moves (`markSaved`) and All
 * skills hears of it (`noteFileSaved`), exactly as the editor's own save.
 */

import { invoke } from "@tauri-apps/api/core";
import { isFileDirty, useEditor } from "../store/editorStore";
import { noteFileSaved } from "../store/allSkillsStore";
import { noteEditorSave } from "../store/folderChanges";
import { confirmChoice, confirmSheet } from "../store/confirmStore";
import { isNotTextOnDisk, markNotTextOnDisk } from "./diskNotText";
import { pushToast } from "../store/toastStore";
import { basename, samePath } from "./paths";
import type { UnsavedFile } from "./quitGuard";
import { pushErrorToast } from "./errorToast";

function errorText(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
}

/** QoL 1.168 review: told of every save made here (Save all, Save and
 *  close, ⌘S outside the text), so the editor clears that tab's "Not saved"
 *  from an earlier failed ⌘S. */
const savedListeners = new Set<(workspaceId: string, path: string) => void>();
export function onOpenFileSaved(fn: (workspaceId: string, path: string) => void): () => void {
  savedListeners.add(fn);
  return () => {
    savedListeners.delete(fn);
  };
}

/** Every open file with unsaved changes, in every workspace (or one). */
export function unsavedFiles(workspaceId?: string): UnsavedFile[] {
  const out: UnsavedFile[] = [];
  for (const [wsId, ws] of Object.entries(useEditor.getState().byWorkspace)) {
    if (workspaceId !== undefined && wsId !== workspaceId) continue;
    for (const f of ws.openFiles) {
      if (isFileDirty(f) && !f.refused) out.push({ workspaceId: wsId, path: f.path });
    }
  }
  return out;
}

/** Save one open file's current text. Rejects with the write's error. A file
 *  that is no longer open, or is not dirty, resolves at once. */
export async function saveOpenFile(workspaceId: string, path: string): Promise<void> {
  const file = useEditor
    .getState()
    .byWorkspace[workspaceId]?.openFiles.find((f) => samePath(f.path, path));
  if (!file || !isFileDirty(file) || file.refused) return;
  const content = file.content;
  // Windows re-check of block 6: the disk holds something this tab never
  // read (it stopped being text); writing over it is asked first, as the
  // editor's own ⌘S does. Declined, the file is not saved and says why.
  if (isNotTextOnDisk(workspaceId, file.path)) {
    const name = basename(file.path);
    const ok = await confirmSheet({
      title: `Replace ${name} on disk?`,
      body: "The file changed on disk and isn't plain text any more. Saving writes this tab's text over it.",
      confirmLabel: "Replace",
      destructive: true,
    });
    if (!ok) throw new Error(`${name} changed on disk and isn't plain text any more, so it wasn't saved.`);
  }
  await invoke<void>("fs_write_text_file", { path: file.path, content });
  markNotTextOnDisk(workspaceId, file.path, false);
  // A keystroke after the write started stays unsaved: only mark the text
  // that was written.
  const now = useEditor
    .getState()
    .byWorkspace[workspaceId]?.openFiles.find((f) => samePath(f.path, path));
  if (now && now.content === content) useEditor.getState().markSaved(workspaceId, file.path);
  noteFileSaved(workspaceId, file.path);
  // 1.174.0 E1: the watcher drops this write as Plyloft's own; "Same
  // folder" still counts it.
  noteEditorSave(workspaceId, file.path);
  for (const fn of savedListeners) fn(workspaceId, file.path);
}

/** Save each file; returns the ones that could not be written. */
export async function saveFiles(
  files: UnsavedFile[],
): Promise<{ path: string; workspaceId: string; error: string }[]> {
  const failed: { path: string; workspaceId: string; error: string }[] = [];
  for (const f of files) {
    try {
      await saveOpenFile(f.workspaceId, f.path);
    } catch (e) {
      failed.push({ ...f, error: errorText(e) });
    }
  }
  return failed;
}

/**
 * QoL 1.168 S1-1 + E5: close a tab the way its × does — the one path ⌘W
 * takes too. A clean tab closes at once; one with unsaved changes asks
 * "Save and close / Don't save / Cancel". Save and close that can't write
 * keeps the tab open and says why. Resolves whether the tab was closed.
 */
export async function closeEditorTab(workspaceId: string, path: string): Promise<boolean> {
  const file = useEditor
    .getState()
    .byWorkspace[workspaceId]?.openFiles.find((f) => samePath(f.path, path));
  if (!file) return false;
  if (!isFileDirty(file)) {
    useEditor.getState().close(workspaceId, file.path);
    return true;
  }
  const name = basename(file.path);
  const answer = await confirmChoice({
    title: `Save the changes to ${name}?`,
    body: "Closing the tab without saving loses them.",
    confirmLabel: "Save and close",
    altLabel: "Don't save",
    cancelLabel: "Cancel",
  });
  if (answer === "alt") {
    useEditor.getState().close(workspaceId, file.path);
    return true;
  }
  if (answer !== "confirm") return false;
  try {
    await saveOpenFile(workspaceId, file.path);
  } catch (e) {
    pushErrorToast(`${name} could not be saved`, e, { then: "The tab stays open with your changes." });
    return false;
  }
  useEditor.getState().close(workspaceId, file.path);
  return true;
}

/**
 * QoL 1.168 E4: ⌘⌥S and the palette's "Save all files" — every unsaved file
 * of the workspace. Says what happened in a toast.
 */
export async function saveAllInWorkspace(workspaceId: string): Promise<void> {
  const files = unsavedFiles(workspaceId);
  if (files.length === 0) {
    pushToast({ kind: "info", title: "Nothing to save", body: "Every open file is saved." });
    return;
  }
  const failed = await saveFiles(files);
  if (failed.length === 0) {
    pushToast({
      kind: "info",
      title: files.length === 1 ? "1 file saved" : `${files.length} files saved`,
    });
    return;
  }
  pushToast({
    kind: "error",
    title:
      failed.length === 1
        ? `${basename(failed[0].path)} could not be saved`
        : `${failed.length} files could not be saved`,
    body: "Their tabs keep your changes.",
    details: failed.map((f) => `${f.path}: ${f.error}`).join("\n"),
  });
}

/** QoL 1.168 E4: ⌘S outside the editor's text (the tab bar, the file tree)
 *  while Code is on screen — the active file. */
export async function saveActiveFile(workspaceId: string): Promise<void> {
  const ws = useEditor.getState().byWorkspace[workspaceId];
  const path = ws?.activePath;
  if (!path) return;
  try {
    await saveOpenFile(workspaceId, path);
  } catch (e) {
    pushErrorToast(`${basename(path)} could not be saved`, e, { then: "The tab keeps your changes." });
  }
}
