// Windows port (W5): the few path questions the frontend asks — a file's
// name, its folder, whether it is absolute, whether it is inside a root.
// macOS paths only ever use `/` (a `\` is a legal file-name character there,
// so it is never a separator on the Mac); Windows paths use `\` and `/` both.
// Pure, so node can test it.

import { isWindows } from "./platform.ts";

function separators(win: boolean): RegExp {
  return win ? /[\\/]/ : /\//;
}

/** The index of the last separator in `path`, or -1. */
export function lastSeparator(path: string, win: boolean = isWindows()): number {
  const slash = path.lastIndexOf("/");
  return win ? Math.max(slash, path.lastIndexOf("\\")) : slash;
}

/** The last part of `path`, as `split("/").pop()` gave it on the Mac: a path
 *  ending in a separator has an empty name. */
export function basename(path: string, win: boolean = isWindows()): string {
  return path.slice(lastSeparator(path, win) + 1);
}

/** Everything before the last separator, or "" when there is none. */
export function dirname(path: string, win: boolean = isWindows()): string {
  const i = lastSeparator(path, win);
  return i < 0 ? "" : path.slice(0, i);
}

/** The non-empty parts of `path`. */
export function pathParts(path: string, win: boolean = isWindows()): string[] {
  return path.split(separators(win)).filter(Boolean);
}

/** `/Users/…`, `C:\…`, `C:/…` or `\\server\share\…`. Every form is absolute
 *  wherever it is asked: none of the Windows forms is a sensible relative
 *  path on the Mac either. */
export function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

/** `path` below `root`, or null when it is not inside it. On Windows the
 *  comparison ignores case (drive letter and folders alike) and takes either
 *  separator; the part returned keeps `path`'s own separators. */
export function relativeTo(path: string, root: string, win: boolean = isWindows()): string | null {
  if (!win) {
    const r = root.replace(/\/+$/, "");
    return path.startsWith(r + "/") ? path.slice(r.length + 1) : null;
  }
  const r = root.replace(/[\\/]+$/, "");
  const head = path.slice(0, r.length);
  const same = head.replace(/\\/g, "/").toLowerCase() === r.replace(/\\/g, "/").toLowerCase();
  const sep = path.charAt(r.length);
  return same && (sep === "/" || sep === "\\") ? path.slice(r.length + 1) : null;
}

/** `rel` under `root`. On the Mac, `root/rel` (one trailing `/` of the root
 *  dropped). On Windows the root's own separator joins them and replaces
 *  `rel`'s, so the path is the same string the backend's tree gives the file —
 *  the editor tells files apart by that string. */
export function joinPath(root: string, rel: string, win: boolean = isWindows()): string {
  if (!win) return `${root.replace(/\/$/, "")}/${rel}`;
  const sep = root.includes("\\") ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${sep}${rel.replace(/[\\/]+/g, sep)}`;
}

/** `path` with `/` for every separator — what a repository-relative path
 *  published for every platform carries. Unchanged on the Mac. */
export function toPosix(path: string, win: boolean = isWindows()): string {
  return win ? path.replace(/\\/g, "/") : path;
}

/**
 * The key two spellings of one file share: on Windows either separator (and
 * runs of them) and any case name the same file, so `C:\\app\\.claude/skills\\x`
 * and `c:/app/.claude/skills/x` are one. On the Mac the path itself: `\\` is a
 * file-name character there, and the disk may be case-sensitive.
 */
export function pathKey(path: string, win: boolean = isWindows()): string {
  if (!win) return path;
  // The verbatim prefix a canonicalised Windows path carries names the same
  // file: `\\?\C:\x` is `C:\x`, and `\\?\UNC\server\share` is
  // `\\server\share`.
  const plain = path
    .replace(/^[\\/]{2}\?[\\/]UNC[\\/]/i, "\\\\")
    .replace(/^[\\/]{2}\?[\\/]/, "");
  const unc = /^[\\/]{2}[^\\/]/.test(plain);
  const body = plain.replace(/[\\/]+/g, "\\").toLowerCase();
  // A UNC path keeps its leading pair of separators.
  return unc ? `\\${body}` : body;
}

/** Whether `a` and `b` name the same file ([`pathKey`]). */
export function samePath(a: string, b: string, win: boolean = isWindows()): boolean {
  return a === b || pathKey(a, win) === pathKey(b, win);
}
