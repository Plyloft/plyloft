/**
 * QoL 1.168 S1-1 + E4: what ⌘W, ⌘S and ⌘⌥S do, by where the person is.
 *
 * ⌘W closes the active file only while Code is on screen (through the tab's
 * × path, which asks first about unsaved changes); in Terminals it restores
 * an expanded tile; anywhere else it does nothing — it used to close a hidden
 * editor tab from the Board, unsaved changes and all. ⌘S inside the text is
 * the editor's own; elsewhere in Code it saves the active file; ⌘⌥S saves all
 * of the workspace's files. Outside Code neither does anything.
 *
 * Pure, so node runs it (`editorKeys.test.ts`).
 */

export interface KeyPlace {
  /** The active workspace's mode (`effectiveCenterMode`). */
  mode: string;
  /** Settings is over the shell. */
  settingsOpen: boolean;
  /** A sheet or dialog is on screen. */
  modalOpen: boolean;
}

export type CloseTabAction = "closeFile" | "collapseTile" | "nothing";

export function codeOnScreen(p: KeyPlace): boolean {
  return p.mode === "code" && !p.settingsOpen && !p.modalOpen;
}

export function closeTabAction(
  p: KeyPlace & { expandedTile: boolean; activeFile: boolean },
): CloseTabAction {
  if (p.modalOpen) return "nothing";
  if (codeOnScreen(p)) return p.activeFile ? "closeFile" : "nothing";
  if (p.mode === "terminals" && !p.settingsOpen && p.expandedTile) return "collapseTile";
  return "nothing";
}

export type SaveKeyAction = "editor" | "saveActive" | "saveAll" | "ignore";

export function saveKeyAction(
  id: "save" | "saveAll",
  p: KeyPlace & { inEditorText: boolean },
): SaveKeyAction {
  if (id === "save" && p.inEditorText) return "editor";
  if (!codeOnScreen(p)) return "ignore";
  return id === "saveAll" ? "saveAll" : "saveActive";
}
