// QoL 6.2 / 6.3: the Code tree's pure rules — how a fresh listing of a folder
// joins the one on screen, which names the watcher reports that are nobody's
// file, and where an open file goes when its folder is renamed. Pure, so node
// can test it.

import { joinPath, relativeTo, samePath } from "./paths.ts";
import { isWindows } from "./platform.ts";

/** What a tree row carries beyond its entry: kept across a fresh listing. */
export interface TreeNodeLike {
  entry: { path: string };
}

/**
 * QoL 6.2 (E3): a folder listed again (a file came or went) keeps what the
 * person opened. Each fresh entry takes the state of the row it replaces —
 * expanded or not, the children already loaded, their own expanded folders
 * below — and only rows that are new start closed. Rows gone from disk go.
 * The order is the fresh listing's.
 */
export function mergeListing<N extends TreeNodeLike>(old: readonly N[] | null, fresh: readonly N[]): N[] {
  if (!old || old.length === 0) return [...fresh];
  const byPath = new Map(old.map((n) => [n.entry.path, n]));
  return fresh.map((n) => {
    const was = byPath.get(n.entry.path);
    return was ? { ...was, entry: n.entry } : n;
  });
}

/**
 * Names the watcher reports that are no one's file: Plyloft's own atomic
 * write (`name.atelier-tmp`, a drop's `.drop-…`), and the probes and swap
 * files editors leave for a moment (vim's `4913` and `.swp`, emacs' `.#`,
 * a trailing `~`). A change to one never reloads a folder.
 */
export function isTransientName(name: string): boolean {
  return (
    name.endsWith(".atelier-tmp") ||
    name === "4913" ||
    name.startsWith(".#") ||
    /\.sw[a-p]$/.test(name) ||
    name.endsWith("~")
  );
}

/** Whether `path` is `root` or inside it. */
export function isAtOrUnder(path: string, root: string, win: boolean = isWindows()): boolean {
  return samePath(path, root, win) || relativeTo(path, root, win) !== null;
}

/** Where `path` is once `from` was renamed to `to` (itself, or a file inside
 *  a renamed folder); `null` when the rename did not move it. */
export function movedPath(path: string, from: string, to: string, win: boolean = isWindows()): string | null {
  if (samePath(path, from, win)) return to;
  const rel = relativeTo(path, from, win);
  return rel === null ? null : joinPath(to, rel, win);
}
