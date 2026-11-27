// Windows re-check of block 6: an open file that something outside Plyloft
// made unreadable as text (PowerShell 5.1's `>>` appends UTF-16LE, so NUL
// bytes) — the tab keeps the text it had, says so, and ⌘S asks before it
// writes that text over what is on disk. Per workspace and file (`pathKey`).
// Kept outside React so every save path (⌘S, Save all) can ask it.
import { pathKey } from "./paths.ts";

const marked = new Set<string>();
const key = (workspaceId: string, path: string) => `${workspaceId}\0${pathKey(path)}`;

export function markNotTextOnDisk(workspaceId: string, path: string, on: boolean): void {
  if (on) marked.add(key(workspaceId, path));
  else marked.delete(key(workspaceId, path));
}

/** Whether the file on disk is no longer text this tab could have read. */
export function isNotTextOnDisk(workspaceId: string, path: string): boolean {
  return marked.has(key(workspaceId, path));
}

/** The notice above such a tab. */
export function notTextLine(name: string): string {
  return `${name} changed on disk and isn't plain text any more. Plyloft can't show it.`;
}
