import { ptyShellAlone, type ShellEnvInfo } from "../ipc";
import { closeAllAsks, closeAllQuestion, closeAsks, type CloseFacts } from "../lib/tileClose";
import { useAgents } from "./agentStore";
import { newTileKindFor, type NewTileKind } from "../lib/newTileKind";
import { adjacentTile } from "../lib/tileNav";
import { visibleModalOpen } from "../lib/visibleModal";
import { confirmSheet } from "./confirmStore";
import { openCodexTile } from "./openCodexTile";
import { useSettings } from "./settingsStore";
import { useTiles, type Tile } from "./tileStore";
import { effectiveCenterMode, openCenterMode, useUi } from "./uiStore";
import { useWorkspaces } from "./workspaceStore";

/**
 * QoL 1.168 block 3 (D1, A1, D4, D8): what the member does to tiles from
 * anywhere — open one, show one, move between them, close them — lands on
 * Terminals with the keyboard in the tile. One module, so ⌘T, ⌘K, the
 * sidebar, the Inbox, Resume… and the tile's own buttons all do the same.
 *
 * Focus follows a member's action only, never a background event: every
 * caller here is a click or a key.
 */

// ── Focus ────────────────────────────────────────────────────────────────

/** How long a focus request keeps trying: a new tile's terminal mounts a
 *  frame or two after its tile, a workspace not yet warmed takes longer, and
 *  a hidden host (`visibility: hidden`) refuses focus until it is shown. */
const FOCUS_TRY_FRAMES = 150;
/** Held this many frames in a row: a closing palette or menu, which gives
 *  focus back to where it was, has had its turn. */
const FOCUS_HOLD_FRAMES = 3;

let focusSeq = 0;
/** The tile each workspace last had the keyboard in. */
const lastFocused = new Map<string, string>();
let tracking = false;

function trackFocus(): void {
  if (tracking || typeof document === "undefined") return;
  tracking = true;
  document.addEventListener(
    "focusin",
    (e) => {
      const el = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-tile-id]") : null;
      const id = el?.dataset.tileId;
      const ws = el?.dataset.tileWorkspace;
      if (id && ws) lastFocused.set(ws, id);
    },
    true,
  );
}
trackFocus();

function tileElement(tileId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-tile-id="${CSS.escape(tileId)}"]`);
}

/** Where the keyboard goes inside a tile: xterm's input, a Codex chat's
 *  composer, else the tile itself. */
function tileFocusTarget(tileEl: HTMLElement): HTMLElement {
  return (
    tileEl.querySelector<HTMLElement>(".xterm-helper-textarea") ??
    tileEl.querySelector<HTMLElement>("textarea:not([disabled])") ??
    tileEl
  );
}

/** Something on screen holds the keyboard, and a focus request waits
 *  behind it: a sheet, the ⌘K palette, an open menu. */
function keyboardHeld(): boolean {
  if (visibleModalOpen()) return true;
  if (document.querySelector(".palette-backdrop")) return true;
  return [...document.querySelectorAll<HTMLElement>('[role="menu"]')].some(
    (m) => m.getClientRects().length > 0 && getComputedStyle(m).visibility !== "hidden",
  );
}

function isEditable(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName.toLowerCase();
  return tag === "textarea" || (tag === "input" && (el as HTMLInputElement).type !== "button");
}

const MODIFIER_KEYS = new Set(["Meta", "Control", "Shift", "Alt", "AltGraph", "CapsLock", "Fn"]);

/** QoL 1.168 (H2): a focus request gives way to what the member does next. */
export function focusRequestYields(
  e: { key: string; metaKey: boolean; ctrlKey: boolean; target: EventTarget | null },
  target: HTMLElement | null,
): boolean {
  if (MODIFIER_KEYS.has(e.key)) return false;
  // A shortcut (⌘P, ⌘K…) is the member going somewhere else.
  if (e.metaKey || e.ctrlKey) return true;
  // Typing into a field of their own; keys that reach nothing (the body)
  // were meant for the tile, so the request goes on.
  return isEditable(e.target) && e.target !== target;
}

/** Keep trying `find()`'s element until it holds focus for a few frames, or
 *  give up. It waits behind a sheet, the palette or a menu; a newer
 *  request, a click, a shortcut or typing into another field, and focus
 *  moving into another field once nothing held the keyboard, cancel it. */
function focusSoon(find: () => HTMLElement | null): void {
  if (typeof window === "undefined") return;
  const seq = ++focusSeq;
  let tries = 0;
  let held = 0;
  let cancelled = false;
  let target: HTMLElement | null = null;
  /** The last frame saw nothing holding the keyboard: a focus move from
   *  now on is the member's (a closing palette giving focus back is not). */
  let free = false;
  const cancel = () => {
    cancelled = true;
  };
  const onKey = (e: KeyboardEvent) => {
    if (focusRequestYields(e, target)) cancelled = true;
  };
  const onFocusIn = (e: FocusEvent) => {
    if (free && e.target !== target && isEditable(e.target)) cancelled = true;
  };
  const stop = () => {
    window.removeEventListener("pointerdown", cancel, { capture: true });
    window.removeEventListener("keydown", onKey, { capture: true });
    document.removeEventListener("focusin", onFocusIn, { capture: true });
  };
  window.addEventListener("pointerdown", cancel, { capture: true });
  document.addEventListener("focusin", onFocusIn, { capture: true });
  let first = true;
  const step = () => {
    // The key that asked is over by now; the next one is the member's.
    if (first) {
      first = false;
      window.addEventListener("keydown", onKey, { capture: true });
    }
    if (cancelled || seq !== focusSeq || tries++ > FOCUS_TRY_FRAMES) {
      stop();
      return;
    }
    const blocked = keyboardHeld();
    const el = blocked ? null : find();
    target = el;
    if (el && document.activeElement !== el) {
      held = 0;
      try {
        el.focus({ preventScroll: true });
      } catch {
        // ignore
      }
    }
    free = !blocked;
    if (el && document.activeElement === el) held += 1;
    if (held >= FOCUS_HOLD_FRAMES) {
      stop();
      return;
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** 1.173.0 A3 (walk fix): a tile was asked for — Terminals shows its grid
 *  (Copies, drawn over it, closes). Detail: the tile's id. */
export const TILE_SHOWN_EVENT = "ply:tile-shown";

/** The keyboard into a tile's terminal (or chat composer). */
export function focusTile(tileId: string): void {
  window.dispatchEvent(new CustomEvent<string>(TILE_SHOWN_EVENT, { detail: tileId }));
  focusSoon(() => {
    const el = tileElement(tileId);
    if (!el) return null;
    const target = tileFocusTarget(el);
    if (target === el && !el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
    return target;
  });
}

/** The tile the keyboard is in now, if it is one of `workspaceId`'s. */
function tileWithFocus(workspaceId: string): string | null {
  const el =
    document.activeElement instanceof Element
      ? document.activeElement.closest<HTMLElement>("[data-tile-id]")
      : null;
  return el && el.dataset.tileWorkspace === workspaceId ? (el.dataset.tileId ?? null) : null;
}

function liveTiles(workspaceId: string): Tile[] {
  return (useTiles.getState().byWorkspace[workspaceId]?.tiles ?? []).filter((t) => !t.pendingClose);
}

/** The tile the keyboard commands act on: the one with focus, else the
 *  expanded one, else the last one focused, else the first. */
export function currentTileId(workspaceId: string): string | null {
  const tiles = liveTiles(workspaceId);
  if (tiles.length === 0) return null;
  const has = (id: string | null | undefined) => (id && tiles.some((t) => t.id === id) ? id : null);
  return (
    has(tileWithFocus(workspaceId)) ??
    has(useTiles.getState().byWorkspace[workspaceId]?.expandedTileId) ??
    has(lastFocused.get(workspaceId)) ??
    tiles[0].id
  );
}

/**
 * After a workspace switch (⌘1–9, ⌘K): the keyboard goes into that
 * workspace's page, not the sidebar — the current tile on Terminals, the
 * editor on Code, the page itself anywhere else.
 */
export function focusActivePane(workspaceId: string): void {
  const mode = effectiveCenterMode(useUi.getState().centerMode, workspaceId);
  if (mode === "terminals") {
    const id = currentTileId(workspaceId);
    if (id) {
      focusTile(id);
      return;
    }
  }
  focusSoon(() => {
    if (useWorkspaces.getState().activeId !== workspaceId) return null;
    if (mode === "code") {
      const editor = document.querySelector<HTMLElement>(".center-mode-sticky:not(.hidden) .cm-content");
      if (editor) return editor;
    }
    const host = [...document.querySelectorAll<HTMLElement>(".center-mode-host:not(.hidden), .center-card-host:not(.hidden)")].find(
      (h) => !h.querySelector(".center-mode-host"),
    );
    const page = host?.querySelector<HTMLElement>("main") ?? host ?? null;
    if (page && !page.hasAttribute("tabindex")) page.setAttribute("tabindex", "-1");
    return page;
  });
}

// ── Open and show ────────────────────────────────────────────────────────

function showTerminals(workspaceId: string): void {
  const workspaces = useWorkspaces.getState();
  if (workspaces.activeId !== workspaceId) void workspaces.setActive(workspaceId);
  openCenterMode(workspaceId, "terminals");
}

/**
 * Show a tile on Terminals with the keyboard in it: a sidebar row, an Inbox
 * row, Resume… on a conversation a tile already runs, a notification.
 * `expand` (the default) gives it the whole grid, as those always did.
 */
export function showTile(workspaceId: string, tileId: string, how: { expand?: boolean } = {}): void {
  showTerminals(workspaceId);
  if (how.expand ?? true) useTiles.getState().setExpanded(workspaceId, tileId);
  focusTile(tileId);
}

/** A tile a member's action just opened: Terminals, with the keyboard in it. */
export function showNewTile(tile: Tile | null | undefined): void {
  if (!tile) return;
  showTerminals(tile.workspaceId);
  focusTile(tile.id);
}

/**
 * A new tile of a kind, from a key or a command — ⌘T (the kind Settings ›
 * What a new tile opens chooses), ⌘⇧T, ⌘⇧X, ⌘K's New … rows, the Terminals
 * page's New ▾. Shown on Terminals with the keyboard in it.
 */
export function openNewTile(
  workspaceId: string,
  cwd: string,
  kind: NewTileKind,
  env: ShellEnvInfo | null | undefined,
): Tile | null {
  const tiles = useTiles.getState();
  const tile =
    kind === "claude"
      ? tiles.addClaudeTile(workspaceId, cwd)
      : kind === "codex"
        ? openCodexTile(workspaceId, cwd, env)
        : tiles.addShellTile(workspaceId, cwd);
  showNewTile(tile);
  return tile;
}

/** ⌘T: the kind Settings chooses, when it is installed here; else a shell. */
export function openDefaultTile(workspaceId: string, cwd: string, env: ShellEnvInfo | null | undefined): Tile | null {
  const kind = newTileKindFor(useSettings.getState().settings.terminals, {
    claude: Boolean(env?.claudePath),
    codex: Boolean(env?.codexPath),
  });
  return openNewTile(workspaceId, cwd, kind, env);
}

// ── Move, expand, close ──────────────────────────────────────────────────

/** ⌘⇧] / ⌘⇧[: the next or previous tile. With one expanded, the next one
 *  takes the grid instead. */
export function focusAdjacentTile(workspaceId: string, dir: 1 | -1): boolean {
  const tiles = liveTiles(workspaceId);
  const next = adjacentTile(
    tiles.map((t) => t.id),
    currentTileId(workspaceId),
    dir,
  );
  if (!next) return false;
  if (useTiles.getState().byWorkspace[workspaceId]?.expandedTileId) {
    useTiles.getState().setExpanded(workspaceId, next);
  }
  focusTile(next);
  return true;
}

/** ⌘⇧Enter and the tile's own button: expand the tile, or give the grid
 *  back; the keyboard stays in it. */
export function toggleExpandTile(workspaceId: string, tileId: string): void {
  const expanded = useTiles.getState().byWorkspace[workspaceId]?.expandedTileId === tileId;
  useTiles.getState().setExpanded(workspaceId, expanded ? null : tileId);
  focusTile(tileId);
}

/** Whether closing this tile asks first (`closeAsks`), reading a shell's
 *  PTY for a running command. */
export async function tileCloseAsks(tile: Tile, status: Tile["status"] = tile.status): Promise<boolean> {
  const facts: CloseFacts = {
    kind: tile.kind,
    status,
    sessionBusy: tile.sessionBusy,
    readiness: tile.readiness,
    question: tile.question ?? null,
    inputEmpty: tile.inputEmpty,
    inputDraft: tile.inputDraft,
    startedAt: tile.startedAt,
  };
  if (tile.kind === "shell" && tile.status === "running" && tile.ptyId) {
    facts.shellAlone = await ptyShellAlone(tile.ptyId).catch(() => null);
  }
  return closeAsks(facts, Date.now());
}

type CloseListener = (tileId: string) => void;
const closeListeners = new Set<CloseListener>();

/** A tile's own close path (its × button: the question it asks, a swarm's
 *  words) listens here, so ⌘⇧W closes the same way the button does. */
export function onTileCloseRequest(listener: CloseListener): () => void {
  closeListeners.add(listener);
  return () => closeListeners.delete(listener);
}

/** 1.174.0 E1: close one tile through its own close path (it asks only
 *  when something would be lost) — the toast after a Same folder copy. */
export function requestCloseTile(tileId: string): void {
  for (const l of closeListeners) l(tileId);
}

/** ⌘⇧W: close the current tile, through its own close path. The tile
 *  hands the keyboard to a neighbour once it is closed. */
export function requestCloseCurrentTile(workspaceId: string): boolean {
  const id = currentTileId(workspaceId);
  if (!id) return false;
  for (const l of closeListeners) l(id);
  return true;
}

/** A tile is closing (L2): the tile that takes its place — the next one,
 *  else the previous one — is the current one from now on, at once, so a
 *  ⌘⇧] or ⌘⇧W right after acts on it; from the keyboard it also gets the
 *  keyboard. */
export function handOverFrom(workspaceId: string, tileId: string, how: { focus: boolean }): void {
  // A click on another tile's × leaves the current one where it is.
  if (!how.focus && lastFocused.get(workspaceId) !== tileId) return;
  const ids = liveTiles(workspaceId).map((t) => t.id);
  const next = adjacentTile(ids, tileId, 1);
  if (!next || next === tileId) {
    if (lastFocused.get(workspaceId) === tileId) lastFocused.delete(workspaceId);
    return;
  }
  lastFocused.set(workspaceId, next);
  if (how.focus) focusTile(next);
}

/** For tests: the tile the keyboard commands would act on next. */
export function lastFocusedTileForTests(workspaceId: string): string | undefined {
  return lastFocused.get(workspaceId);
}

/** The sessions ⋯ › Close all closes: every tile not already closing. */
export function closableTiles(workspaceId: string): Tile[] {
  return liveTiles(workspaceId);
}

/** ⋯ › Close all (M4): every tile of the page, after one question — always
 *  for more than one, and for one that is working — that names a swarm it
 *  would abort. Each then closes as its own × does once answered. */
export async function closeAllTiles(workspaceId: string): Promise<void> {
  const tiles = closableTiles(workspaceId);
  if (tiles.length === 0) return;
  const runs = useAgents.getState().byWorkspace[workspaceId]?.runs ?? [];
  const runOf = (t: Tile) => (t.kind === "agent-run" && t.runId ? runs.find((r) => r.id === t.runId) ?? null : null);
  const asks = await Promise.all(
    tiles.map((t) => {
      const run = runOf(t);
      return tileCloseAsks(t, run ? (run.status as Tile["status"]) : t.status);
    }),
  );
  const working = asks.filter(Boolean).length;
  const swarm = tiles.some((t) => runOf(t)?.swarmId);
  if (closeAllAsks(working, tiles.length)) {
    const q = closeAllQuestion(working, tiles.length, swarm);
    const ok = await confirmSheet({ title: q.title, body: q.body, confirmLabel: q.confirmLabel, destructive: working > 0 || swarm });
    if (!ok) return;
  }
  useTiles.getState().setExpanded(workspaceId, null);
  for (const t of tiles) {
    await useTiles
      .getState()
      .closeTile(t.id)
      .catch((e) => console.error("closeTile failed", e));
  }
}

// ── Resume… ──────────────────────────────────────────────────────────────

/** ⌘⇧R: the Terminals page's Resume… sheet (TileGrid listens). */
export const OPEN_RESUME_EVENT = "ply:open-resume";

export function openResume(workspaceId: string): void {
  showTerminals(workspaceId);
  window.dispatchEvent(new CustomEvent(OPEN_RESUME_EVENT, { detail: { workspaceId } }));
}

/** What ⌘T opens here now — for the hints that name ⌘T beside a kind. */
export function useDefaultNewTileKind(env: ShellEnvInfo | null | undefined): NewTileKind {
  const pane = useSettings((s) => s.settings.terminals.defaultNewPaneKind);
  const chosen = useSettings((s) => s.settings.terminals.newTileKind ?? null);
  return newTileKindFor(
    { defaultNewPaneKind: pane, newTileKind: chosen },
    { claude: Boolean(env?.claudePath), codex: Boolean(env?.codexPath) },
  );
}
