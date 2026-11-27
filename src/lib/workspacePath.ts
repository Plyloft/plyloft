// UX-8.5: a file's path as Code's header shows it — relative to the
// workspace — and its breadcrumb. The absolute path stays in a title.
//
// Pure: no React, no store.

import { pathParts, relativeTo } from "./paths.ts";
import { tildeForm } from "./projectsFolder.ts";

/** `path` relative to `cwd`, or null when it is not inside it. */
export function relativeToWorkspace(path: string, cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  return relativeTo(path, cwd);
}

/** The folders above the file (for the breadcrumb) and its name. */
export function pathCrumbs(
  path: string,
  cwd: string | null | undefined,
): { folders: string[]; name: string } {
  const rel = relativeToWorkspace(path, cwd);
  const parts = pathParts(rel ?? path);
  const name = parts.pop() ?? path;
  // Outside the workspace (a dropped file in the cache): the name alone.
  return { folders: rel === null ? [] : parts, name };
}

/**
 * 1.174.0 (TX2, T9; WALK 32; D-T5): the workspaces whose name another one
 * shares — only those show their folder in the switcher. Names are compared
 * as they read (trimmed), so "sandbox monorepo" twice is a pair.
 */
export function sharedNameIds(workspaces: readonly { id: string; name: string }[]): Set<string> {
  const byName = new Map<string, string[]>();
  for (const w of workspaces) {
    const key = w.name.trim();
    byName.set(key, [...(byName.get(key) ?? []), w.id]);
  }
  const shared = new Set<string>();
  for (const ids of byName.values()) if (ids.length > 1) for (const id of ids) shared.add(id);
  return shared;
}

/**
 * The switcher's quiet folder line: a folder inside the home folder starts
 * from it — `~/code/sandbox-monorepo` on a Mac, `…\code\sandbox-monorepo` on
 * Windows — and any other folder is said as it is.
 */
export function switcherFolder(cwd: string, home: string | null, windows: boolean): string {
  const short = tildeForm(cwd, home);
  if (short !== "~" && !short.startsWith("~/")) return cwd;
  if (!windows) return short;
  return short === "~" ? "…" : `…${short.slice(1).replace(/\//g, "\\")}`;
}
