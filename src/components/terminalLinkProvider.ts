import type { IDisposable, ILink, Terminal as XTerm } from "@xterm/xterm";
import { openWebLink, terminalLinkTarget } from "../ipc";
import { openInEditor } from "../lib/openInEditor";
import { isWindows } from "../lib/platform";
import {
  fileUrlPath,
  findPaths,
  findUrls,
  isWebUrl,
  linkHint,
  opensLink,
  osc8Hint,
  type FoundLink,
} from "../lib/terminalLinks";
import { pushToast } from "../store/toastStore";
import { linkDidNotOpen } from "../lib/linkToast";
import { openCenterMode } from "../store/uiStore";

/**
 * QoL 1.168 (block 4, D6): clickable links in a Terminals tile. A web address
 * opens in the browser through `open_web_link` (http and https only, as
 * every other link in Plyloft); a file path — relative to the tile's folder,
 * or absolute, with the line and column a tool printed — opens in Code at
 * that line, only when the backend says it is a file inside the workspace
 * (`terminal_link_target`). ⌘-click on the Mac, Ctrl-click on Windows; a plain
 * click still selects. OSC 8 hyperlinks (`linkHandler`) follow the same rules.
 */

/** A path's answer is kept this long: a file the session creates becomes a
 *  link soon after. */
const TARGET_TTL_MS = 15_000;
/** A logical line wrapped over more rows than this is not read for links. */
const MAX_WRAPPED_ROWS = 12;

const targets = new Map<string, { at: number; target: Promise<string | null> }>();

function linkTarget(workspaceId: string, cwd: string, path: string): Promise<string | null> {
  const key = `${workspaceId}\0${cwd}\0${path}`;
  const now = Date.now();
  const hit = targets.get(key);
  if (hit && now - hit.at < TARGET_TTL_MS) return hit.target;
  const target = terminalLinkTarget(workspaceId, cwd, path).then(
    (t) => t ?? null,
    () => null,
  );
  targets.set(key, { at: now, target });
  if (targets.size > 500) targets.delete(targets.keys().next().value!);
  return target;
}

/** Open `path` in Code, on its line (and column) when one was printed. */
export async function openFileAtLine(workspaceId: string, path: string, line?: number, col?: number): Promise<void> {
  if (!(await openInEditor(workspaceId, path))) return;
  openCenterMode(workspaceId, "code");
  if (!line) return;
  // Two frames, so EditorPanel's swap-document effect has run (as ⌘K's
  // In files does).
  requestAnimationFrame(() =>
    requestAnimationFrame(() =>
      window.dispatchEvent(new CustomEvent("atelier:goto-line", { detail: { workspaceId, path, line, col } })),
    ),
  );
}

/** A web address (`findUrls`, or an OSC 8 link `isWebUrl` let through) in
 *  the browser; one it didn't take is E10's one form (TX6). */
function openUrl(url: string): void {
  void openWebLink(url).catch((e: unknown) => pushToast(linkDidNotOpen(url, e)));
}

/** The text of the logical line through buffer row `row0` (0-based), with
 *  the cell (1-based x, y) of each character — wide characters and wrapped
 *  rows included. */
function logicalLine(term: XTerm, row0: number): { text: string; cells: { x: number; y: number }[] } | null {
  const buf = term.buffer.active;
  let first = row0;
  while (first > 0 && buf.getLine(first)?.isWrapped && row0 - first < MAX_WRAPPED_ROWS) first -= 1;
  let last = row0;
  while (buf.getLine(last + 1)?.isWrapped && last - first < MAX_WRAPPED_ROWS) last += 1;
  let text = "";
  const cells: { x: number; y: number }[] = [];
  const cell = buf.getNullCell();
  for (let y = first; y <= last; y += 1) {
    const line = buf.getLine(y);
    if (!line) return null;
    for (let x = 0; x < line.length; x += 1) {
      if (!line.getCell(x, cell)) break;
      if (cell.getWidth() === 0) continue;
      const chars = cell.getChars() || " ";
      for (const ch of chars) {
        for (let i = 0; i < ch.length; i += 1) {
          text += ch[i];
          cells.push({ x: x + 1, y: y + 1 });
        }
      }
    }
  }
  return { text, cells };
}

function rangeOf(cells: { x: number; y: number }[], found: FoundLink, width: (i: number) => number) {
  const start = cells[found.start];
  const endCell = cells[found.end - 1];
  if (!start || !endCell) return null;
  return { start, end: { x: endCell.x + width(found.end - 1) - 1, y: endCell.y } };
}

/** Install the links on a tile's terminal. Returns what removes them. */
export function installTerminalLinks(
  term: XTerm,
  ctx: () => { workspaceId: string; cwd: string },
): IDisposable {
  const windows = isWindows();
  const hint = (kind: "url" | "path") => {
    if (term.element) term.element.title = linkHint(kind, windows);
  };
  const unhint = () => {
    if (term.element) term.element.title = "";
  };

  const provider = term.registerLinkProvider({
    provideLinks(y, callback) {
      const logical = logicalLine(term, y - 1);
      if (!logical || !logical.text.trim()) return callback(undefined);
      const { text, cells } = logical;
      const buf = term.buffer.active;
      const widthAt = (i: number) => {
        const c = cells[i];
        return c ? (buf.getLine(c.y - 1)?.getCell(c.x - 1)?.getWidth() ?? 1) || 1 : 1;
      };
      const onRow = (r: { start: { y: number }; end: { y: number } }) => r.start.y <= y && r.end.y >= y;
      const urls = findUrls(text);
      const links: ILink[] = [];
      for (const u of urls) {
        const range = rangeOf(cells, u, widthAt);
        if (!range || !onRow(range)) continue;
        links.push({
          range,
          text: u.text,
          decorations: { underline: true, pointerCursor: true },
          activate: (e, url) => {
            if (opensLink(e, windows)) openUrl(url);
          },
          hover: () => hint("url"),
          leave: unhint,
        });
      }
      const { workspaceId, cwd } = ctx();
      const paths = workspaceId && cwd ? findPaths(text, windows, urls) : [];
      const onThisRow = paths
        .map((p) => ({ p, range: rangeOf(cells, p, widthAt) }))
        .filter((x): x is { p: (typeof paths)[number]; range: NonNullable<ReturnType<typeof rangeOf>> } => !!x.range && onRow(x.range));
      if (onThisRow.length === 0) return callback(links.length ? links : undefined);
      void Promise.all(onThisRow.map(({ p }) => linkTarget(workspaceId, cwd, p.path))).then((found) => {
        onThisRow.forEach(({ p, range }, i) => {
          const target = found[i];
          if (!target) return;
          links.push({
            range,
            text: p.text,
            decorations: { underline: true, pointerCursor: true },
            activate: (e) => {
              if (opensLink(e, windows)) void openFileAtLine(workspaceId, target, p.line, p.col);
            },
            hover: () => hint("path"),
            leave: unhint,
          });
        });
        callback(links.length ? links : undefined);
      });
    },
  });

  // OSC 8 hyperlinks a CLI prints (a web address, or a `file://` path).
  term.options.linkHandler = {
    allowNonHttpProtocols: true,
    activate: (e, url) => {
      if (!opensLink(e, windows)) return;
      if (isWebUrl(url)) return openUrl(url);
      const path = fileUrlPath(url, windows);
      if (!path) return;
      const { workspaceId, cwd } = ctx();
      if (!workspaceId) return;
      void linkTarget(workspaceId, cwd, path).then((target) => {
        if (target) void openFileAtLine(workspaceId, target);
      });
    },
    hover: (_e, url) => {
      const words = osc8Hint(url, windows);
      if (term.element) term.element.title = words ?? "";
    },
    leave: unhint,
  };

  // Lane-1 Mac walk: xterm asks the providers once per row the mouse is on
  // and keeps the answer until the mouse changes row. Output that lands
  // under a resting mouse (`echo https://…` printed on the row it sits on)
  // was never asked about: no underline, ⌘-click did nothing. New output
  // drops that answer, so the next move asks again.
  const parsed = term.onWriteParsed?.(() => forgetLinkRow(term));

  return {
    dispose() {
      provider.dispose();
      parsed?.dispose();
      term.options.linkHandler = null;
      unhint();
    },
  };
}

/** Drop xterm's answer for the row under the mouse (its linkifier's private
 *  line cache: xterm 5.5 and 6 have no public way). `linkRowCacheReachable` pins it
 *  in a test, so an xterm that moves it fails there, not in a walk. */
function forgetLinkRow(term: XTerm): void {
  const linkifier = (term as unknown as { _core?: { linkifier?: { _activeLine?: number } } })._core?.linkifier;
  if (linkifier && typeof linkifier._activeLine === "number") linkifier._activeLine = -1;
}

/** Tests: xterm still keeps its row cache where `forgetLinkRow` drops it. */
export function linkRowCacheReachable(term: XTerm): boolean {
  const linkifier = (term as unknown as { _core?: { linkifier?: Record<string, unknown> } })._core?.linkifier;
  return !!linkifier && "_activeLine" in linkifier;
}

/** Tests: forget the paths' answers. */
export function forgetLinkTargetsForTests(): void {
  targets.clear();
}
