// U28, U32: reads for the Board and its moves. U28: which of the board's issues an open pull request closes, for the Board
// tile. One read per Board, display only (`pr_links::kanban_open_pr_links`).
import { invoke } from "@tauri-apps/api/core";

export interface OpenPrLink {
  issue: number;
  number: number;
  author: string | null;
}

export function kanbanOpenPrLinks(workspaceId: string) {
  return invoke<OpenPrLink[]>("kanban_open_pr_links", { workspaceId });
}

/** U32: why this project's folder can't hold a build, or null. */
export function projectFolderCheck(workspaceId: string) {
  return invoke<string | null>("project_folder_check", { workspaceId });
}

/** U31: whether the project's folder is there. */
export function workspaceCwdExists(id: string) {
  return invoke<boolean>("workspace_cwd_exists", { id });
}
