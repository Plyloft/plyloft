/**
 * QoL 1.168 (block 4, D6): the links in a terminal tile's output — web
 * addresses (`http://localhost:5173`, a pull request, a sign-in page) and
 * file paths (`src/app.ts:12:5`, `./notes.md`, `C:\app\main.rs(3,1)`). Found
 * here, in plain text; a path is a link only once the backend says it is a
 * file inside the workspace (`terminal_link_target`). Pure, so node runs its
 * tests (`terminalLinks.test.ts`).
 */

export interface FoundLink {
  /** Index of the first character, and one past the last, in the text. */
  start: number;
  end: number;
  text: string;
}

export interface FoundUrl extends FoundLink {
  kind: "url";
}

export interface FoundPath extends FoundLink {
  kind: "path";
  /** The path alone, without its line and column. */
  path: string;
  line?: number;
  col?: number;
}

/** At most this many paths are looked up for one line of output. */
export const MAX_PATHS_PER_LINE = 12;

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;
/** What a sentence puts after an address, not part of it. */
const TRAILING = /[.,;:!?'"’”]+$/;

/** A closing bracket the address didn't open is the sentence's. */
function trimUnbalanced(url: string): string {
  let out = url;
  for (;;) {
    const before = out;
    out = out.replace(TRAILING, "");
    for (const [open, close] of [["(", ")"], ["[", "]"], ["{", "}"], ["<", ">"]] as const) {
      while (out.endsWith(close) && count(out, open) < count(out, close)) out = out.slice(0, -1);
    }
    if (out === before) return out;
  }
}

function count(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n += 1;
  return n;
}

/** The web addresses in `text`, left to right. */
export function findUrls(text: string): FoundUrl[] {
  const out: FoundUrl[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const raw = trimUnbalanced(m[0]);
    // Only a scheme and `//`: nothing to open.
    if (/^https?:\/\/$/i.test(raw) || raw.length < 10) continue;
    out.push({ kind: "url", start: m.index!, end: m.index! + raw.length, text: raw });
  }
  return out;
}

/** A path segment: letters, digits and the usual filename marks. */
const SEG = String.raw`[\w@%+=~-][\w.@%+=~-]*`;
/** Unix-style: `./a/b.ts`, `../a`, `/abs/a.ts`, `~/a`, `a/b/c.ts`, `name.ext`. */
const UNIX_PATH = String.raw`(?:~|\.{1,2})?(?:\/${SEG})+\/?|${SEG}(?:\/${SEG})+|${SEG}\.[A-Za-z][\w]{0,9}`;
/** Windows-style: `C:\a\b.ts`, `.\a\b`, `a\b\c.rs` (forward slashes too). */
const WIN_PATH = String.raw`[A-Za-z]:[\\/](?:${SEG}[\\/]?)+|\.{1,2}[\\/](?:${SEG}[\\/]?)+|${SEG}(?:\\${SEG})+`;
/** After a path: `:12`, `:12:5`, `(12,5)`, `(12)`, `, line 12`. */
const POSITION = String.raw`(?::(\d+)(?::(\d+))?|\((\d+)(?:,\s?(\d+))?\)|,\s+line\s+(\d+))?`;

function pathRe(windows: boolean): RegExp {
  const body = windows ? `${WIN_PATH}|${UNIX_PATH}` : UNIX_PATH;
  // Not in the middle of a word or an address.
  return new RegExp(String.raw`(?<![\w/\\.:@-])(${body})${POSITION}`, "g");
}

/** What looks like a version number, a time or a number, not a file. */
function implausible(path: string): boolean {
  if (/^\d+(\.\d+)+$/.test(path)) return true; // 1.2.3
  if (/^v\d/i.test(path) && /^v?\d+(\.\d+)*$/i.test(path)) return true;
  if (/^[.~]+$/.test(path)) return true;
  // A bare `name.ext` must end in letters (an extension), not a sentence's dot.
  return false;
}

/**
 * The file paths in `text` (outside any address in `urls`), with the line
 * and column a compiler or a search printed after them. `windows` also
 * finds `C:\…` and backslash paths.
 */
export function findPaths(text: string, windows: boolean, urls: ReadonlyArray<FoundLink> = findUrls(text)): FoundPath[] {
  const out: FoundPath[] = [];
  for (const m of text.matchAll(pathRe(windows))) {
    const start = m.index!;
    let path = m[1];
    let end = start + m[0].length;
    if (urls.some((u) => start < u.end && end > u.start)) continue;
    // A sentence's full stop after a path isn't part of it.
    if (m[0] === path) {
      const trimmed = path.replace(/[.,;:]+$/, "");
      end -= path.length - trimmed.length;
      path = trimmed;
    }
    if (!path || implausible(path)) continue;
    const line = Number(m[2] ?? m[4] ?? m[6] ?? NaN);
    const col = Number(m[3] ?? m[5] ?? NaN);
    out.push({
      kind: "path",
      start,
      end,
      text: text.slice(start, end),
      path,
      ...(Number.isFinite(line) && line > 0 ? { line } : {}),
      ...(Number.isFinite(col) && col > 0 ? { col } : {}),
    });
    if (out.length >= MAX_PATHS_PER_LINE) break;
  }
  return out;
}

/** A `file://` address (an OSC 8 link) as a path, or null. */
export function fileUrlPath(url: string, windows: boolean): string | null {
  if (!/^file:\/\//i.test(url)) return null;
  try {
    const u = new URL(url);
    if (u.host && u.host !== "localhost") return null;
    let p = decodeURIComponent(u.pathname);
    // Challenger round 1: `file:////host/share/x` is a share (UNC on
    // Windows), never a local file.
    if (p.startsWith("//") || p.startsWith("\\\\")) return null;
    // `file:///C:/app/a.ts` → `C:/app/a.ts`
    if (windows && /^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
    return p || null;
  } catch {
    return null;
  }
}

/** Only web addresses leave Plyloft (the backend refuses any other scheme). */
export function isWebUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/** A link opens on ⌘-click on the Mac and Ctrl-click on Windows, as in the
 *  terminals people know, so a plain click can still select and focus. */
export function opensLink(e: { metaKey: boolean; ctrlKey: boolean }, windows: boolean): boolean {
  return windows ? e.ctrlKey : e.metaKey;
}

/** What hovering an OSC 8 link says, or null where nothing would open it
 *  (`mailto:`, `vscode:`, a share). */
export function osc8Hint(url: string, windows: boolean): string | null {
  if (isWebUrl(url)) return linkHint("url", windows);
  return fileUrlPath(url, windows) ? linkHint("path", windows) : null;
}

/** What hovering a link says. */
export function linkHint(kind: "url" | "path", windows: boolean): string {
  const key = windows ? "Ctrl-click" : "⌘-click";
  return kind === "url" ? `${key} to open in the browser` : `${key} to open in Code`;
}
