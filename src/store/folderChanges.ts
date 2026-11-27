// 1.174.0 E1 (P18, D7 b): "Same folder" warns only once a file in the folder
// changed while both sessions were open. This keeps, per workspace and in
// memory only, when each file last changed: what the watcher reported
// (`fs://changed`: every path under the workspace outside `.git`,
// node_modules and build output — the copies' and cards' folders included,
// which `changedSince` tells apart) and Plyloft's own editor saves, which
// the watcher drops as its own writes (`noteEditorSave`). Files git ignores
// don't count (`checkIgnored`). Nothing is written to disk.
import { create } from "zustand";
import { fsIgnoredPaths, onFileChange } from "../ipc";
import { basename, pathKey } from "../lib/paths";
import { isWindows } from "../lib/platform";

/** Files remembered per folder bucket (the project folder, and each copy's
 *  or card's folder on its own); the oldest go first past this. */
export const FOLDER_CHANGES_CAP = 300;
/** Reported changes are gathered and recorded together this often. */
export const FOLDER_CHANGES_FLUSH_MS = 250;
/** A file recorded this recently isn't recorded again. */
export const FOLDER_CHANGES_REPEAT_MS = 1000;

type Entry = { at: number; path: string };
type ByPath = Record<string, Entry>;
type Change = { workspaceId: string; path: string; at: number };

interface FolderChangesState {
  byWorkspace: Record<string, ByPath>;
  /** Per workspace, per file key: whether git ignores the file. */
  ignored: Record<string, Record<string, boolean>>;
  record: (workspaceId: string, path: string, at: number) => void;
  recordMany: (items: Change[]) => void;
  markIgnored: (workspaceId: string, answers: Record<string, boolean>) => void;
}

/** One file's key: the same file however it is spelled (on Windows case and
 *  separators fold — `pathKey`), with no trailing separator. */
export function folderKey(path: string, win: boolean = isWindows()): string {
  return pathKey(path, win).replace(/[\\/]+$/, "");
}

const BUCKET = /^(.*?[\\/]\.(?:plyloft|atelier)-worktrees[\\/][^\\/]+)/i;

/** Round 2 (Challenger, E1 1): the folder a key's cap is counted in — a
 *  copy's or card's own folder, or "" for everything else (the project
 *  folder). Making a copy writes thousands of files; they never push the
 *  project folder's changes out. */
function bucketOf(key: string): string {
  return BUCKET.exec(key)?.[1] ?? "";
}

export const useFolderChanges = create<FolderChangesState>((set, get) => ({
  byWorkspace: {},
  ignored: {},
  record: (workspaceId, path, at) => get().recordMany([{ workspaceId, path, at }]),
  recordMany: (items) =>
    set((s) => {
      if (items.length === 0) return s;
      const byWorkspace = { ...s.byWorkspace };
      const touched = new Set<string>();
      for (const { workspaceId, path, at } of items) {
        if (isAtomicTemp(path)) continue;
        if (!touched.has(workspaceId)) {
          byWorkspace[workspaceId] = { ...(byWorkspace[workspaceId] ?? {}) };
          touched.add(workspaceId);
        }
        const k = folderKey(path);
        const prev = byWorkspace[workspaceId][k];
        if (!prev || prev.at < at) byWorkspace[workspaceId][k] = { at, path };
      }
      if (touched.size === 0) return s;
      let ignored = s.ignored;
      for (const id of touched) {
        const next = byWorkspace[id];
        const buckets = new Map<string, string[]>();
        for (const k of Object.keys(next)) {
          const b = bucketOf(k);
          const list = buckets.get(b);
          if (list) list.push(k);
          else buckets.set(b, [k]);
        }
        const evicted: string[] = [];
        for (const keys of buckets.values()) {
          if (keys.length <= FOLDER_CHANGES_CAP) continue;
          keys.sort((a, b) => next[a].at - next[b].at);
          for (const k of keys.slice(0, keys.length - FOLDER_CHANGES_CAP)) {
            delete next[k];
            evicted.push(k);
          }
        }
        // Round 2 (E1 3): an evicted file's git answer goes with it.
        const answers = ignored[id];
        if (answers && evicted.some((k) => k in answers)) {
          const kept = { ...answers };
          for (const k of evicted) delete kept[k];
          ignored = { ...ignored, [id]: kept };
        }
      }
      return { byWorkspace, ignored };
    }),
  markIgnored: (workspaceId, answers) =>
    set((s) => ({ ignored: { ...s.ignored, [workspaceId]: { ...(s.ignored[workspaceId] ?? {}), ...answers } } })),
}));

// Challenger 1 (E1-1): a copy's `git worktree add` reports thousands of
// files at once. Changes are gathered and recorded once per flush, and a
// file recorded within the last second is skipped.
let pending = new Map<string, Change>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function flush() {
  flushTimer = null;
  const items = [...pending.values()];
  pending = new Map();
  useFolderChanges.getState().recordMany(items);
}

/** One reported change, recorded at the next flush. */
export function queueFolderChange(workspaceId: string, path: string, at: number = Date.now()): void {
  // 1.174.0 walk G3b: Plyloft's own atomic-write temp file (the watcher
  // drops it too) is never a change of the folder.
  if (isAtomicTemp(path)) return;
  const k = folderKey(path);
  const known = useFolderChanges.getState().byWorkspace[workspaceId]?.[k];
  if (known && at - known.at < FOLDER_CHANGES_REPEAT_MS) return;
  const id = `${workspaceId}\u0000${k}`;
  if (pending.has(id)) return;
  pending.set(id, { workspaceId, path, at });
  if (flushTimer === null) flushTimer = setTimeout(flush, FOLDER_CHANGES_FLUSH_MS);
}

/** Round 2 (E1 4): a workspace whose watcher stopped (closed, or evicted
 *  from the warmed set) forgets its changes, queued ones and git's answers. */
export function forgetFolderChanges(workspaceId: string): void {
  for (const [id, item] of pending) if (item.workspaceId === workspaceId) pending.delete(id);
  generation.set(workspaceId, (generation.get(workspaceId) ?? 0) + 1);
  useFolderChanges.setState((s) => {
    if (!(workspaceId in s.byWorkspace) && !(workspaceId in s.ignored)) return s;
    const { [workspaceId]: _changes, ...byWorkspace } = s.byWorkspace;
    const { [workspaceId]: _answers, ...ignored } = s.ignored;
    return { byWorkspace, ignored };
  });
}

/** Bumped by `forgetFolderChanges`: an answer asked for before it lands
 *  nowhere. */
const generation = new Map<string, number>();

/** `<name>.atelier-tmp` and `<name>.<random>.atelier-tmp` (Rust's
 *  `atomic::TEMP_SUFFIX`). */
export function isAtomicTemp(path: string): boolean {
  return /\.atelier-tmp$/i.test(path);
}

/** E1-4 (a): a save from Plyloft's own editor. The watcher drops it as
 *  Plyloft's own write, yet both sessions read the file it changed. */
export function noteEditorSave(workspaceId: string, path: string): void {
  useFolderChanges.getState().record(workspaceId, path, Date.now());
}

let listening: Promise<void> | null = null;

/** Start listening once (every warmed workspace's watcher emits here); the
 *  promise settles once the listener is in place. */
export function listenForFolderChanges(): Promise<void> {
  if (listening) return listening;
  listening = onFileChange((e) => queueFolderChange(e.workspaceId, e.path)).then(
    () => undefined,
    () => {
      listening = null;
    },
  );
  return listening;
}

const WORKTREES = /[\\/]\.(plyloft|atelier)-worktrees([\\/]|$)/i;

/** The part of key `path` below key `root`, with its leading separator
 *  ("" for the root itself); null when it isn't inside. */
function below(path: string, root: string): string | null {
  if (path === root) return "";
  if (!path.startsWith(root)) return null;
  const sep = path.charAt(root.length);
  return sep === "/" || sep === "\\" ? path.slice(root.length) : null;
}

/** Is `folder` one the workspace's watcher reports on: the project folder
 *  or any folder inside it — a copy's (`.plyloft-worktrees/copy-…`) too,
 *  where two tiles in that copy follow the same rule. */
export function folderIsWatched(
  folder: string,
  workspaceCwd: string | null | undefined,
  win: boolean = isWindows(),
): boolean {
  if (!workspaceCwd) return false;
  return below(folderKey(folder, win), folderKey(workspaceCwd, win)) !== null;
}

/** The files under `folder` that changed after `since`, most recent first.
 *  A file in a copy's or card's folder below `folder` doesn't count for it
 *  (a tile in the project folder isn't touched by a copy's work, nor by
 *  making one). With `ignored` given, files git ignores don't count, and
 *  `unknown` lists those not asked about yet (they don't count either). */
export function changedSince(
  byPath: ByPath | undefined,
  folder: string,
  since: number,
  ignored?: Record<string, boolean>,
  win: boolean = isWindows(),
): { count: number; names: string[]; unknown: string[] } {
  if (!byPath) return { count: 0, names: [], unknown: [] };
  const root = folderKey(folder, win);
  const hits: Entry[] = [];
  const unknown: string[] = [];
  for (const [k, e] of Object.entries(byPath)) {
    if (e.at < since) continue;
    const rest = below(k, root);
    if (rest === null || WORKTREES.test(rest)) continue;
    if (ignored) {
      const answer = ignored[k];
      if (answer === undefined) {
        unknown.push(e.path);
        continue;
      }
      if (answer) continue;
    }
    hits.push(e);
  }
  hits.sort((a, b) => b.at - a.at);
  return { count: hits.length, names: hits.map((e) => basename(e.path, win)), unknown };
}

const asking = new Set<string>();

/** E1-4 (b): ask git once per file which of `paths` it ignores in `cwd`
 *  (`fs_ignored_paths`: one batched `git check-ignore`). A folder git
 *  can't answer for ignores nothing. */
export async function checkIgnored(workspaceId: string, cwd: string, paths: string[]): Promise<void> {
  const fresh = paths.filter((p) => !asking.has(`${workspaceId}\u0000${folderKey(p)}`));
  if (fresh.length === 0) return;
  for (const p of fresh) asking.add(`${workspaceId}\u0000${folderKey(p)}`);
  const asked = generation.get(workspaceId) ?? 0;
  let ignored: string[] = [];
  try {
    ignored = (await fsIgnoredPaths(cwd, fresh)) ?? [];
  } catch {
    ignored = [];
  }
  const out = new Set(ignored.map((p) => folderKey(p)));
  const answers: Record<string, boolean> = {};
  for (const p of fresh) {
    const k = folderKey(p);
    answers[k] = out.has(k);
    asking.delete(`${workspaceId}\u0000${k}`);
  }
  if ((generation.get(workspaceId) ?? 0) !== asked) return;
  // Only files still remembered: an evicted one's answer isn't kept.
  const known = useFolderChanges.getState().byWorkspace[workspaceId] ?? {};
  for (const k of Object.keys(answers)) if (!(k in known)) delete answers[k];
  useFolderChanges.getState().markIgnored(workspaceId, answers);
}

/** For tests: forget everything. */
export function resetFolderChangesForTests(): void {
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = null;
  pending = new Map();
  asking.clear();
  generation.clear();
  useFolderChanges.setState({ byWorkspace: {}, ignored: {} });
  listening = null;
}

/** For tests: record what is queued now. */
export function flushFolderChangesForTests(): void {
  if (flushTimer !== null) clearTimeout(flushTimer);
  flush();
}
