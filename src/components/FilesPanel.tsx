import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import type { DirEntry } from "../types";
import { Icon, MenuList, type MenuItem } from "./ux";
import { FILES_ROW_DROP_KINDS, acceptsAttr } from "../lib/dropGuard";
import {
  onFileChange,
  filesOrderGet,
  filesOrderSet,
  filesOrderClear,
  fsCreateDir,
  fsCreateFile,
  fsRenameEntry,
  fsRevealEntry,
  fsTrashEntry,
  fsUndoTrash,
} from "../ipc";
import { basename, dirname, lastSeparator, relativeTo, samePath } from "../lib/paths";
import { failure, type Failure } from "../lib/failure";
import { FailureText } from "./ux/FailureText";
import { useSettings } from "../store/settingsStore";
import { isHiddenName } from "../lib/hiddenFiles";
import { isAtOrUnder, isTransientName, mergeListing, movedPath } from "../lib/filesTree";
import { useEditor, isFileDirty } from "../store/editorStore";
import { pushToast } from "../store/toastStore";
import { openInEditor } from "../lib/openInEditor";
import { rawError } from "../lib/cardPage";
import { isWindows, platformWord } from "../lib/platform";
import { pushErrorToast } from "../lib/errorToast";
import { folderListCause } from "../lib/plainError";
import { ReadAgainButton } from "./ReadAgainButton";
import { pressRunning } from "../lib/pressOnce";
import { TRY_AGAIN, retryCanHelp } from "../lib/errorButtons";

const filesReadKey = (workspaceId: string, path: string) => `files-read:${workspaceId}:${path}`;

type Node = {
  entry: DirEntry;
  expanded: boolean;
  children: Node[] | null;
  loading: boolean;
  error?: string;
  /** 1.176.3: listing this folder again can change the outcome (not when it is gone). */
  retry?: boolean;
};

type Props = {
  workspaceId: string;
  cwd: string;
  onOpen: (path: string) => void;
};

/** QoL 6.3: the row being named — a new file or folder in `dir`, or a rename. */
type Naming =
  | { kind: "file" | "folder"; dir: string }
  | { kind: "rename"; path: string; dir: string };

/** QoL 6.3: the context menu, at the pointer; `node` null is the tree itself. */
type Menu = { x: number; y: number; node: Node | null; customOrder: boolean };

/** QoL 6.3: Code's ⋯ (New file, New folder) asks the tree of its workspace. */
export const FILES_NEW_EVENT = "ply:files-new";
export type FilesNewDetail = { workspaceId: string; kind: "file" | "folder" };

const DRAG_MIME = "application/atelier-file-row";

/** Sentences `files.rs` refuses a name with — already plain words. */
const OWN_NAME_REFUSAL = /^(Type a name|A name can't|Something named|\u201c|Too many files)/;

/** A failed New file, New folder or Rename, said plainly; the backend's own
 *  refusal of a name is its sentence, anything else goes behind Details. */
function namingFailure(kind: Naming["kind"], e: unknown): Failure {
  const raw = rawError(e);
  if (OWN_NAME_REFUSAL.test(raw)) return { sentence: raw, details: "" };
  const what = kind === "file" ? "make the file" : kind === "folder" ? "make the folder" : "rename it";
  return failure(`Plyloft couldn't ${what}.`, e);
}

/** What the Trash is called here, in a sentence and on a menu item. */
function binName(): string {
  return isWindows() ? "the Recycle Bin" : "the Trash";
}

function applyCustomOrder(nodes: Node[], order: string[] | null): Node[] {
  if (!order || order.length === 0) return nodes;
  const orderMap = new Map<string, number>();
  order.forEach((name, i) => orderMap.set(name, i));
  return [...nodes].sort((a, b) => {
    if (a.entry.isDir !== b.entry.isDir) return a.entry.isDir ? -1 : 1;
    const aRank = orderMap.has(a.entry.name) ? orderMap.get(a.entry.name)! : Infinity;
    const bRank = orderMap.has(b.entry.name) ? orderMap.get(b.entry.name)! : Infinity;
    if (aRank !== bRank) return aRank - bRank;
    return a.entry.name.toLowerCase().localeCompare(b.entry.name.toLowerCase());
  });
}

async function loadChildren(workspaceId: string, path: string, includeHidden: boolean): Promise<Node[]> {
  const entries = await invoke<DirEntry[]>("fs_list_dir", {
    path,
    includeHidden,
  });
  const nodes: Node[] = entries.map((entry) => ({
    entry,
    expanded: false,
    children: null,
    loading: false,
  }));
  const order = await filesOrderGet(workspaceId, path).catch(() => null);
  return applyCustomOrder(nodes, order);
}

/** The loaded folders of `nodes`, deepest last. */
function loadedDirs(nodes: Node[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.entry.isDir && n.children !== null) {
      out.push(n.entry.path);
      loadedDirs(n.children, out);
    }
  }
  return out;
}

/** `tree` without the row at `path` (and what was under it). */
function withoutPath(tree: Node[] | null, path: string): Node[] | null {
  if (!tree) return tree;
  function walk(nodes: Node[]): Node[] {
    return nodes
      .filter((n) => n.entry.path !== path)
      .map((n) => (n.children ? { ...n, children: walk(n.children) } : n));
  }
  return walk(tree);
}

/** `tree` with `dir`'s children replaced by `update(children)` (the root
 *  when `dir` is `cwd`). */
function withChildren(
  tree: Node[] | null,
  cwd: string,
  dir: string,
  update: (children: Node[] | null) => Node[],
): Node[] | null {
  if (!tree) return tree;
  if (samePath(dir, cwd)) return update(tree);
  function walk(nodes: Node[]): Node[] {
    return nodes.map((n) => {
      if (n.entry.path === dir && n.entry.isDir) return { ...n, children: update(n.children) };
      if (n.children) return { ...n, children: walk(n.children) };
      return n;
    });
  }
  return walk(tree);
}

export function FilesPanel({ workspaceId, cwd, onOpen }: Props) {
  const [tree, setTree] = useState<Node[] | null>(null);
  const [error, setError] = useState<Failure | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [naming, setNaming] = useState<Naming | null>(null);
  const [namingError, setNamingError] = useState<Failure | null>(null);
  /** Challenger L4: the last move to the bin, with its Undo, kept in the tree. */
  const [trashed, setTrashed] = useState<{ token: string; name: string; undo: (() => void) | null } | null>(null);
  // QoL 6.1 (D12): Settings › Code › Show hidden files, also in Code's ⋯.
  const hidden = useSettings((s) => s.settings.editor.showHiddenFiles);
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;
  const treeRef = useRef(tree);
  treeRef.current = tree;
  const menuRef = useRef<HTMLDivElement | null>(null);
  /** Challenger D2: the newest listing asked for, per folder; an older one
   *  that finishes later is dropped. */
  const listingGen = useRef(new Map<string, number>());

  // 1.176.3: the project folder's own listing, again — what "Try again" runs.
  // One generation per listing of the project folder: only the newest lands.
  const rootGen = useRef(0);
  const [rootRetry, setRootRetry] = useState(true);
  const listRoot = useCallback(
    () => {
      const mine = ++rootGen.current;
      return loadChildren(workspaceId, cwd, hiddenRef.current)
        .then((nodes) => {
          if (mine !== rootGen.current) return;
          setTree(nodes);
          setError(null);
        })
        .catch((e) => {
          if (mine !== rootGen.current) return;
          setRootRetry(retryCanHelp(e));
          setError(failure("Plyloft couldn't list this folder's files.", e));
        });
    },
    [workspaceId, cwd],
  );
  useEffect(() => {
    setTree(null);
    setError(null);
    setRootRetry(true);
    void listRoot();
    return () => {
      rootGen.current++;
    };
  }, [listRoot]);

  /**
   * QoL 6.2 (E3): list `dir` again and merge it into what is on screen —
   * open folders stay open, loaded children stay loaded. A folder that was
   * never opened has nothing on screen to refresh.
   */
  const refreshDir = useCallback(
    async (dir: string) => {
      const isRoot = samePath(dir, cwd);
      if (!isRoot) {
        let loaded = false;
        (function find(nodes: Node[] | null) {
          for (const n of nodes ?? []) {
            if (n.entry.path === dir) loaded = n.children !== null;
            else if (n.children) find(n.children);
          }
        })(treeRef.current);
        if (!loaded) return;
      }
      const gens = listingGen.current;
      const mine = (gens.get(dir) ?? 0) + 1;
      gens.set(dir, mine);
      try {
        const fresh = await loadChildren(workspaceId, dir, hiddenRef.current);
        if (gens.get(dir) !== mine) return;
        setTree((t) => withChildren(t, cwd, dir, (old) => mergeListing(old, fresh)));
      } catch {
        // The folder went with the change; its parent's refresh drops it.
      }
    },
    [workspaceId, cwd],
  );

  // Show hidden files switched: every folder on screen is listed again.
  const firstHidden = useRef(true);
  useEffect(() => {
    if (firstHidden.current) {
      firstHidden.current = false;
      return;
    }
    const dirs = [cwd, ...loadedDirs(treeRef.current ?? [])];
    void (async () => {
      for (const dir of dirs) await refreshDir(dir);
    })();
  }, [hidden, cwd, refreshDir]);

  // Refresh on external create/remove — the folder it happened in, merged,
  // once per burst (an AI writing ten files is one listing per folder).
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    const pending = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | null = null;

    onFileChange((e) => {
      if (e.workspaceId !== workspaceId) return;
      if (e.kind !== "created" && e.kind !== "removed") return;
      if (lastSeparator(e.path) < 0) return;
      if (isTransientName(basename(e.path))) return;
      pending.add(dirname(e.path));
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        const dirs = [...pending];
        pending.clear();
        for (const dir of dirs) void refreshDir(dir);
      }, 120);
    })
      .then((u) => {
        if (cancelled) u();
        else unlisten = u;
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (unlisten) unlisten();
    };
  }, [workspaceId, refreshDir]);

  // Code's ⋯ → New file / New folder at the top of the tree.
  useEffect(() => {
    function onNew(e: Event) {
      const detail = (e as CustomEvent<FilesNewDetail>).detail;
      if (!detail || detail.workspaceId !== workspaceId) return;
      setNamingError(null);
      setNaming({ kind: detail.kind, dir: cwd });
    }
    window.addEventListener(FILES_NEW_EVENT, onNew);
    return () => window.removeEventListener(FILES_NEW_EVENT, onNew);
  }, [workspaceId, cwd]);

  // The context menu closes on a press outside it.
  useEffect(() => {
    if (!menu) return;
    function onDown(e: PointerEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as globalThis.Node)) setMenu(null);
    }
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [menu]);

  function updateNode(path: string, updater: (n: Node) => Node) {
    setTree((tree) => {
      if (!tree) return tree;
      function walk(nodes: Node[]): Node[] {
        return nodes.map((n) => {
          if (n.entry.path === path) return updater(n);
          if (n.children) return { ...n, children: walk(n.children) };
          return n;
        });
      }
      return walk(tree);
    });
  }

  /** Opens `dir` in the tree (loading it first when it never was). */
  async function expandDir(dir: string) {
    if (samePath(dir, cwd)) return;
    let found: Node | null = null;
    (function find(nodes: Node[] | null) {
      for (const n of nodes ?? []) {
        if (n.entry.path === dir) found = n;
        else if (n.children) find(n.children);
      }
    })(treeRef.current);
    const node = found as Node | null;
    if (!node || (node.expanded && node.children)) return;
    if (node.children) {
      updateNode(dir, (n) => ({ ...n, expanded: true }));
      return;
    }
    try {
      const children = await loadChildren(workspaceId, dir, hiddenRef.current);
      updateNode(dir, (n) => ({ ...n, expanded: true, loading: false, children, error: undefined }));
    } catch {
      // Listed again on the next change.
    }
  }

  /** Lists a folder that was never opened (or whose listing failed) and
   *  opens it; its failure stays on its row, with Try again when it can help. */
  async function listFolder(dir: string) {
    updateNode(dir, (n) => ({ ...n, loading: true }));
    try {
      const children = await loadChildren(workspaceId, dir, hiddenRef.current);
      updateNode(dir, (n) => ({ ...n, expanded: true, loading: false, children, error: undefined, retry: undefined }));
    } catch (e) {
      updateNode(dir, (n) => ({ ...n, loading: false, error: folderListCause(e), retry: retryCanHelp(e) }));
    }
  }

  async function handleClick(node: Node) {
    if (!node.entry.isDir) {
      onOpen(node.entry.path);
      return;
    }
    if (!node.expanded && node.children === null) {
      // A Try again on this folder is running: that listing is the one.
      if (pressRunning(filesReadKey(workspaceId, node.entry.path))) return;
      await listFolder(node.entry.path);
    } else {
      updateNode(node.entry.path, (n) => ({ ...n, expanded: !n.expanded }));
    }
  }

  function siblingsOfParent(parentPath: string): Node[] | null {
    if (!tree) return null;
    if (parentPath === cwd) return tree;
    function walk(nodes: Node[]): Node[] | null {
      for (const n of nodes) {
        if (n.entry.path === parentPath && n.children) return n.children;
        if (n.children) {
          const found = walk(n.children);
          if (found) return found;
        }
      }
      return null;
    }
    return walk(tree);
  }

  async function persistOrder(parentPath: string, siblings: Node[]) {
    const order = siblings.map((n) => n.entry.name);
    try {
      await filesOrderSet(workspaceId, parentPath, order);
    } catch (e) {
      console.warn("filesOrderSet failed:", e);
    }
  }

  function reorderInTree(
    parentPath: string,
    sourcePath: string,
    targetPath: string,
  ): Node[] | null {
    const siblings = siblingsOfParent(parentPath);
    if (!siblings) return null;
    const sourceIdx = siblings.findIndex((n) => n.entry.path === sourcePath);
    const targetIdx = siblings.findIndex((n) => n.entry.path === targetPath);
    if (sourceIdx < 0 || targetIdx < 0 || sourceIdx === targetIdx) return null;
    const next = [...siblings];
    const [moved] = next.splice(sourceIdx, 1);
    const insertAt = sourceIdx < targetIdx ? targetIdx : targetIdx;
    next.splice(insertAt, 0, moved);
    setTree((tree) => withChildren(tree, cwd, parentPath, () => next));
    return next;
  }

  function onRowDragStart(
    e: React.DragEvent,
    node: Node,
    parentPath: string,
  ) {
    if (node.entry.isDir) {
      e.preventDefault();
      return;
    }
    e.dataTransfer.setData(
      DRAG_MIME,
      JSON.stringify({ path: node.entry.path, parent: parentPath }),
    );
    // v0.5.0: also set generic types so tiles in the new shell can accept
    // the drag and inject the path into their PTY.
    e.dataTransfer.setData("application/x-atelier-path", node.entry.path);
    e.dataTransfer.setData("text/plain", node.entry.path);
    e.dataTransfer.effectAllowed = "copyMove";
  }

  function onRowDragOver(e: React.DragEvent) {
    if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }

  async function onRowDrop(
    e: React.DragEvent,
    target: Node,
    parentPath: string,
  ) {
    if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
    e.preventDefault();
    const raw = e.dataTransfer.getData(DRAG_MIME);
    if (!raw) return;
    let dragged: { path: string; parent: string };
    try {
      dragged = JSON.parse(raw);
    } catch {
      return;
    }
    if (dragged.parent !== parentPath) return;
    if (dragged.path === target.entry.path) return;
    const next = reorderInTree(parentPath, dragged.path, target.entry.path);
    if (next) await persistOrder(parentPath, next);
  }

  async function resetSort(parentPath: string) {
    try {
      await filesOrderClear(workspaceId, parentPath);
      const reloaded = await loadChildren(workspaceId, parentPath, hiddenRef.current);
      setTree((tree) => withChildren(tree, cwd, parentPath, (old) => mergeListing(old, reloaded)));
    } catch {}
  }

  // ── QoL 6.3: file operations ──────────────────────────────────────

  /** The open tabs at or under `path`, and whether any has unsaved changes. */
  function openTabsUnder(path: string) {
    const files = useEditor.getState().byWorkspace[workspaceId]?.openFiles ?? [];
    const under = files.filter((f) => isAtOrUnder(f.path, path));
    return { under, dirty: under.filter((f) => isFileDirty(f)) };
  }

  function refuseDirty(what: string, dirty: { path: string }[]): boolean {
    if (dirty.length === 0) return false;
    pushToast({
      kind: "warn",
      title: `Save or close ${basename(dirty[0].path)} first`,
      body: `It has unsaved changes, so Plyloft didn't ${what} it.`,
    });
    return true;
  }

  async function commitNaming(value: string) {
    const n = naming;
    if (!n) return;
    const name = value.trim();
    if (n.kind === "rename" && name === basename(n.path)) {
      setNaming(null);
      return;
    }
    try {
      if (n.kind !== "rename") {
        if (n.kind === "file") {
          const made = await fsCreateFile(workspaceId, n.dir, name);
          setNaming(null);
          await refreshDir(n.dir);
          // A new file opens straight in the editor.
          onOpen(made);
        } else {
          await fsCreateDir(workspaceId, n.dir, name);
          setNaming(null);
          await refreshDir(n.dir);
        }
      } else {
        const from = n.path;
        const { under, dirty } = openTabsUnder(from);
        if (refuseDirty("rename", dirty)) {
          setNaming(null);
          return;
        }
        // Challenger L1: the tabs close before the rename, so the watcher's
        // "removed" never reaches a tab that is about to follow the file.
        const editor = useEditor.getState();
        const active = editor.byWorkspace[workspaceId]?.activePath ?? null;
        for (const f of under) editor.close(workspaceId, f.path);
        let to: string;
        try {
          to = await fsRenameEntry(workspaceId, from, name);
        } catch (e) {
          for (const f of under) await openInEditor(workspaceId, f.path);
          if (active && under.some((f) => f.path === active)) useEditor.getState().setActive(workspaceId, active);
          throw e;
        }
        setNaming(null);
        await refreshDir(n.dir);
        // The tabs that were open follow the file (or the files of a folder).
        for (const f of under) {
          const moved = movedPath(f.path, from, to);
          if (moved) await openInEditor(workspaceId, moved);
        }
        const movedActive = active ? movedPath(active, from, to) : null;
        if (movedActive) useEditor.getState().setActive(workspaceId, movedActive);
      }
    } catch (e) {
      setNamingError(namingFailure(n.kind, e));
    }
  }

  async function moveToBin(node: Node) {
    const { under, dirty } = openTabsUnder(node.entry.path);
    if (refuseDirty("move", dirty)) return;
    const dir = dirname(node.entry.path);
    const path = node.entry.path;
    // Challenger L1: closed first, so no "removed" warning reaches them.
    for (const f of under) useEditor.getState().close(workspaceId, f.path);
    // Windows walk of block 6: the Recycle Bin can take seconds. The row goes
    // and the line says so at once; Undo is there as soon as the bin answers,
    // and a refusal puts the row and the tabs back.
    const pendingToken = `pending:${path}`;
    setTrashed({ token: pendingToken, name: node.entry.name, undo: null });
    setTree((t) => withoutPath(t, path));
    let token: string;
    try {
      token = await fsTrashEntry(workspaceId, path);
    } catch (e) {
      setTrashed((t) => (t?.token === pendingToken ? null : t));
      await refreshDir(dir);
      for (const f of under) await openInEditor(workspaceId, f.path);
      pushErrorToast(`${node.entry.name} wasn't moved to ${binName()}`, e);
      return;
    }
    const undo = () => {
      setTrashed((t) => (t?.token === token ? null : t));
      fsUndoTrash(token)
        .then(async () => {
          await refreshDir(dir);
          for (const f of under) await openInEditor(workspaceId, f.path);
        })
        .catch((e) =>
          pushErrorToast(`${node.entry.name} couldn't be put back`, e),
        );
    };
    // Challenger L4 / walk of block 6: one message, the tree's own line with
    // its Undo, kept until the next move, an Undo or its × — no toast too.
    setTrashed((t) => (t?.token === pendingToken ? { token, name: node.entry.name, undo } : t));
    await refreshDir(dir);
  }

  function copyText(text: string, what: string) {
    navigator.clipboard
      ?.writeText(text)
      .then(() => pushToast({ kind: "info", title: `${what} copied` }))
      .catch(() => pushToast({ kind: "error", title: `The ${what.toLowerCase()} couldn't be copied` }));
  }

  async function openMenu(e: React.MouseEvent, node: Node | null) {
    e.preventDefault();
    e.stopPropagation();
    await openMenuAt(e.clientX, e.clientY, node);
  }

  /** The context menu at (`x`, `y`): a right-click, the ⋯ of a row, or the
   *  keyboard's menu key / ⇧F10 on a focused row. */
  async function openMenuAt(x: number, y: number, node: Node | null) {
    const dir = node ? (node.entry.isDir ? node.entry.path : null) : cwd;
    const order = dir ? await filesOrderGet(workspaceId, dir).catch(() => null) : null;
    setMenu({ x, y, node, customOrder: !!order && order.length > 0 });
  }

  function startNew(kind: "file" | "folder", dir: string) {
    setNamingError(null);
    setNaming({ kind, dir });
    void expandDir(dir);
  }

  function menuItems(m: Menu): MenuItem[] {
    const node = m.node;
    const dir = node ? (node.entry.isDir ? node.entry.path : dirname(node.entry.path)) : cwd;
    const items: MenuItem[] = [
      { label: "New file", onSelect: () => startNew("file", dir) },
      { label: "New folder", onSelect: () => startNew("folder", dir) },
    ];
    if (node) {
      const rel = relativeTo(node.entry.path, cwd) ?? node.entry.path;
      items.push(
        "divider",
        {
          label: "Rename",
          shortcut: "F2",
          onSelect: () => {
            setNamingError(null);
            setNaming({ kind: "rename", path: node.entry.path, dir: dirname(node.entry.path) });
          },
        },
        {
          label: isWindows() ? "Move to the Recycle Bin" : "Move to Trash",
          shortcut: isWindows() ? "Delete" : "⌘⌫",
          danger: true,
          onSelect: () => void moveToBin(node),
        },
        "divider",
        { label: "Copy path", onSelect: () => copyText(node.entry.path, "Path") },
        { label: "Copy relative path", onSelect: () => copyText(rel, "Relative path") },
      );
    }
    items.push("divider", {
      label: platformWord("reveal"),
      onSelect: () => {
        fsRevealEntry(workspaceId, node ? node.entry.path : cwd).catch((e) =>
          pushErrorToast("Plyloft couldn't show it", e),
        );
      },
    });
    if (m.customOrder) {
      const orderDir = node ? node.entry.path : cwd;
      items.push({ label: "Reset order", hint: "Back to alphabetical order.", onSelect: () => void resetSort(orderDir) });
    }
    return items;
  }

  function onRowKeyDown(e: React.KeyboardEvent<HTMLDivElement>, node: Node) {
    const row = e.currentTarget;
    const rows = () => [
      ...(row.closest(".files-panel")?.querySelectorAll<HTMLElement>(".tree-row") ?? []),
    ];
    const move = (by: number) => {
      const all = rows();
      all[all.indexOf(row) + by]?.focus();
    };
    // Challenger L3: ⌘⌫ (Delete on Windows) moves the row to the bin, as
    // Finder and Explorer do; the menu key or ⇧F10 opens its menu.
    const trashKey = isWindows()
      ? e.key === "Delete" && !e.ctrlKey && !e.altKey && !e.metaKey
      : e.key === "Backspace" && e.metaKey;
    const menuKey = e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey);
    if (trashKey) void moveToBin(node);
    else if (menuKey) {
      const box = row.getBoundingClientRect();
      void openMenuAt(box.left + 24, box.bottom, node);
    } else if (e.key === "ArrowDown") move(1);
    else if (e.key === "ArrowUp") move(-1);
    else if (e.key === "F2") {
      // QoL 6.3: F2 renames, as Finder's Return and Explorer's F2 do.
      setNamingError(null);
      setNaming({ kind: "rename", path: node.entry.path, dir: dirname(node.entry.path) });
    } else if (e.key === "Enter" || e.key === " ") void handleClick(node);
    else if (e.key === "ArrowRight" && node.entry.isDir && !node.expanded) void handleClick(node);
    else if (e.key === "ArrowLeft" && node.entry.isDir && node.expanded) void handleClick(node);
    else return;
    e.preventDefault();
  }

  function namingRow(depth: number, n: Naming) {
    const initial = n.kind === "rename" ? basename(n.path) : "";
    const label =
      n.kind === "file" ? "New file name" : n.kind === "folder" ? "New folder name" : `New name for ${initial}`;
    return (
      <div key="__naming" className="tree-naming" style={{ paddingLeft: 4 + depth * 14 }}>
        <NameField
          initial={initial}
          label={label}
          onCommit={(v) => void commitNaming(v)}
          onCancel={() => {
            setNaming(null);
            setNamingError(null);
          }}
        />
        {namingError && (
          <div className="tree-error">
            <FailureText failure={namingError} />
          </div>
        )}
      </div>
    );
  }

  function render(nodes: Node[], depth: number, parentPath: string): React.ReactNode[] {
    const out: React.ReactNode[] = [];
    if (naming && naming.kind !== "rename" && samePath(naming.dir, parentPath)) {
      out.push(namingRow(depth, naming));
    }
    for (const node of nodes) {
      const renaming = naming?.kind === "rename" && naming.path === node.entry.path;
      out.push(
        <div key={node.entry.path}>
          {renaming ? (
            namingRow(depth, naming)
          ) : (
            <div
              className={`tree-row${node.entry.isDir ? " is-dir" : " is-file"}${isHiddenName(node.entry.name) ? " is-hidden" : ""}`}
              style={{ paddingLeft: 4 + depth * 14 }}
              // UX-8.5: rows are reachable by keyboard — ↑ ↓ move, Enter or
              // Space opens a file or toggles a folder, → and ← open and close.
              role="treeitem"
              tabIndex={0}
              aria-level={depth + 1}
              aria-expanded={node.entry.isDir ? !!node.expanded : undefined}
              onKeyDown={(e) => onRowKeyDown(e, node)}
              onClick={() => handleClick(node)}
              // QoL 6.3 (E7): the row's file operations.
              onContextMenu={(e) => void openMenu(e, node)}
              draggable={!node.entry.isDir}
              // GH #138: a row reorders its own siblings. It takes an internal
              // path drag and nothing else — a Finder file dropped here belongs
              // to the shell's drop guard, which refuses it and says so.
              data-drop-zone="files-row"
              data-drop-accepts={acceptsAttr(FILES_ROW_DROP_KINDS)}
              onDragStart={(e) => onRowDragStart(e, node, parentPath)}
              onDragOver={onRowDragOver}
              onDrop={(e) => onRowDrop(e, node, parentPath)}
              title={node.entry.path}
            >
              <span className="tree-icon" aria-hidden="true">
                {node.entry.isDir ? (
                  <Icon name={node.expanded ? "expand" : "opens"} size="sm" />
                ) : null}
              </span>
              <span className="tree-name">{node.entry.name}</span>
              {node.loading && <span className="tree-loading">…</span>}
              {/* Challenger L3: the row's menu without a right-click. Not a
                  Tab stop of its own: the row's menu key opens the same. */}
              <button
                type="button"
                className="tree-row-more"
                tabIndex={-1}
                aria-label={`More for ${node.entry.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  const box = e.currentTarget.getBoundingClientRect();
                  void openMenuAt(box.left, box.bottom, node);
                }}
              >
                <Icon name="more" size="sm" />
              </button>
            </div>
          )}
          {node.expanded &&
            node.children &&
            render(node.children, depth + 1, node.entry.path)}
          {node.error && (
            <div
              className="tree-error"
              role="group"
              style={{ paddingLeft: 4 + (depth + 1) * 14 }}
            >
              {node.error}
              {node.retry !== false && (
                <>
                  {" "}
                  <ReadAgainButton
                    size="sm"
                    pressKey={filesReadKey(workspaceId, node.entry.path)}
                    name={node.entry.name}
                    label={TRY_AGAIN}
                    run={() => listFolder(node.entry.path)}
                  />
                </>
              )}
            </div>
          )}
        </div>,
      );
    }
    return out;
  }

  return (
    <div
      className="files-panel"
      role="tree"
      aria-label="Files"
      onContextMenu={(e) => {
        if (e.target === e.currentTarget) void openMenu(e, null);
      }}
    >
      {trashed && (
        <div className="tree-trashed" role="status">
          <span className="tree-trashed-text">{`${trashed.name} moved to ${binName()}`}</span>
          <button
            type="button"
            className="tree-trashed-undo"
            disabled={!trashed.undo}
            onClick={() => trashed.undo?.()}
          >
            Undo
          </button>
          <button
            type="button"
            className="tree-trashed-close"
            aria-label="Dismiss"
            onClick={() => setTrashed(null)}
          >
            <Icon name="close" size="sm" />
          </button>
        </div>
      )}
      {error && (
        <div className="files-error">
          <FailureText failure={error} />
          {rootRetry && (
            <div>
              <ReadAgainButton size="sm" pressKey={`files-read:${workspaceId}:${cwd}`} label={TRY_AGAIN} run={listRoot} />
            </div>
          )}
        </div>
      )}
      {!error && !tree && <div className="files-loading">Loading…</div>}
      {tree && tree.length === 0 && !naming && (
        <div className="files-loading">Empty directory.</div>
      )}
      {tree && render(tree, 0, cwd)}
      {menu &&
        // On the page itself, so the tree's scrolling box never cuts it.
        createPortal(
          <div ref={menuRef} className="tree-menu-anchor" style={{ left: menu.x, top: menu.y }}>
            <MenuList
              label={menu.node ? menu.node.entry.name : "Files"}
              items={menuItems(menu)}
              onClose={() => setMenu(null)}
            />
          </div>,
          document.body,
        )}
    </div>
  );
}

/** QoL 6.3: the inline name field — Enter keeps it, Esc (or leaving it)
 *  drops it. For a rename, the name before the extension is selected. */
function NameField({
  initial,
  label,
  onCommit,
  onCancel,
}: {
  initial: string;
  label: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement | null>(null);
  const [value, setValue] = useState(initial);
  /** Esc pressed, or this value already sent: a blur after it does nothing. */
  const done = useRef(false);
  const sent = useRef<string | null>(null);
  const commit = () => {
    if (sent.current === value) return;
    sent.current = value;
    onCommit(value);
  };
  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    input.focus();
    const dot = initial.lastIndexOf(".");
    input.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial]);
  return (
    <input
      ref={ref}
      className="tree-name-input"
      aria-label={label}
      value={value}
      spellCheck={false}
      autoComplete="off"
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          if (value.trim()) commit();
          else onCancel();
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          done.current = true;
          onCancel();
        }
      }}
      // Challenger L4: leaving the field keeps a name that was typed; an
      // empty one (or Esc) drops it.
      onBlur={() => {
        if (done.current) return;
        if (value.trim()) commit();
        else onCancel();
      }}
    />
  );
}
