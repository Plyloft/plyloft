/**
 * Try it (TI-2, docs/try-it/TRY_IT_SPEC.md §4.1, §4.5): a card copy's Try
 * session — the API the card panel (TI-4) and the address scanner (TI-3) use.
 *
 * A Try session is an ordinary shell tile (`runInShellTile` →
 * `tileStore.addShellTile` → `Terminal` → `pty_spawn` → `PtyRegistry::spawn`:
 * the cached PATH, killed on quit) with a `tryOf` marker. The backend gives
 * its environment `PORT` (in a card copy) and `BROWSER=none`, never counts it
 * as making the card busy, and stops it before the copy is removed (ship,
 * archive, delete, a set-aside build), saying why (`card://try-stopped`).
 *
 * One per card copy: starting one where one runs returns that one.
 */
import { onPtyData, ptyKill, tryCmdShimsAvailable, tryFolderExists } from "../ipc";
import { useDoctor } from "../store/doctorStore";
import { useTiles, type Tile } from "../store/tileStore";
import { openCenterMode } from "../store/uiStore";
import { runInShellTile, typeWhenReady, type TileLine } from "./runInTile";
import { isWindows } from "./platform";
import { fallbackTileShell } from "./tileShell";
import {
  TRY_SHIM_NAMES,
  endedTryTiles,
  findTryTile,
  shellFamily,
  tryCommandForShell,
  tryCwdFor,
  tryTileTitle,
  type TryCardLike,
  type TryLane,
} from "./tryTile";

export { TRY_STOPPED_FOR_SHIP, tryStoppedWords, tryCommandCmdForm } from "./tryTile";

/** What a Try session needs of a card. */
export interface TryCard extends TryCardLike {
  id: string;
  workspaceId: string;
  title: string;
}

function tilesOf(workspaceId: string): Tile[] {
  return useTiles.getState().byWorkspace[workspaceId]?.tiles ?? [];
}

function findTile(tileId: string): Tile | null {
  for (const ws of Object.values(useTiles.getState().byWorkspace)) {
    const found = ws.tiles.find((t) => t.id === tileId);
    if (found) return found;
  }
  return null;
}

/** The card copy's running Try session, or null. */
export function trySessionFor(card: Pick<TryCard, "id" | "workspaceId">, lane?: TryLane | null): Tile | null {
  return findTryTile(tilesOf(card.workspaceId), card.id, lane);
}

/** The line a Try session types for `command` in its tile's shell: in
 *  PowerShell on Windows the `.cmd` shim, where the cached PATH has one. */
function lineFor(command: string): TileLine {
  return async (tileShell) => {
    const shell = tileShell ?? useDoctor.getState().env?.shell ?? fallbackTileShell();
    const platform = isWindows() ? "windows" : "mac";
    if (shellFamily(shell, platform) !== "powershell") return command;
    const shims = await tryCmdShimsAvailable(TRY_SHIM_NAMES).catch(() => [] as string[]);
    return tryCommandForShell(command, shell, platform, shims ?? []);
  };
}

/** In-flight starts, by copy: two quick presses start one session. */
const starting = new Map<string, Promise<{ tileId: string; reused: boolean }>>();

const startKey = (card: Pick<TryCard, "id" | "workspaceId">, lane?: TryLane | null) =>
  `${card.workspaceId}\u0000${card.id}\u0000${lane ?? ""}`;

/** Test seams, passed to the typing wait. */
type Seams = { sleep?: (ms: number) => Promise<void>; now?: () => number };

/**
 * Start the card copy's Try session: a shell tile titled "Try · <card
 * title>" in the copy (or `opts.cwd`, the project folder after Ship) with
 * `opts.command` typed into it — in PowerShell on Windows through the
 * package manager's `.cmd` shim when there is one. When one already runs,
 * returns it (`reused: true`) and types nothing. `opts.onOutput` is
 * subscribed before the command is typed; its unsubscribe is
 * `opts.onSubscribed`'s argument.
 */
export function startTrySession(
  card: TryCard,
  lane: TryLane | null | undefined,
  opts: {
    command: string;
    cwd?: string;
    onOutput?: (data: Uint8Array) => void;
    onSubscribed?: (unsubscribe: () => void) => void;
    /** Windows walk: the line as typed, just before it is typed — in
     *  PowerShell the `.cmd` form when there is one. What ran, for Details
     *  and for whether "the other way" is another way at all. */
    onTyped?: (line: string) => void;
    /** TI-4: false starts it without opening Terminals (the card's panel
     *  shows it; Show the session opens the tile). */
    reveal?: boolean;
  } & Seams,
): Promise<{ tileId: string; reused: boolean }> {
  const running = trySessionFor(card, lane);
  if (running) return Promise.resolve({ tileId: running.id, reused: true });
  const key = startKey(card, lane);
  const pending = starting.get(key);
  if (pending) return pending;
  const cwd = opts.cwd ?? tryCwdFor(card, lane);
  if (!cwd) return Promise.reject(new Error("the card has no copy to try"));
  // An ended Try tile of this copy is replaced, not kept beside the new one.
  for (const ended of endedTryTiles(tilesOf(card.workspaceId), card.id, lane)) {
    useTiles.getState().removeTile(ended.id);
  }
  const run = runInShellTile({
    workspaceId: card.workspaceId,
    cwd,
    kind: "try",
    tryOf: { cardId: card.id, ...(lane ? { lane } : {}), command: opts.command },
    title: tryTileTitle(card.title),
    command: lineFor(opts.command),
    beforeType: async (tileId) => {
      if (!opts.onOutput) return;
      const unsubscribe = await subscribeOutput(tileId, opts.onOutput);
      opts.onSubscribed?.(unsubscribe);
    },
    onLine: opts.onTyped,
    reveal: opts.reveal,
    sleep: opts.sleep,
    now: opts.now,
  })
    .then((tileId) => ({ tileId, reused: false }))
    .finally(() => starting.delete(key));
  starting.set(key, run);
  return run;
}

/**
 * Restart an ended Try tile (its header's Restart). Its folder still there:
 * a fresh shell in it with the command typed again. Gone (the copy was
 * removed): the tile goes, and nothing starts in a missing folder. Resolves
 * with the new tile's id, or null when it was removed.
 */
export async function restartTrySession(tileId: string, seams: Seams = {}): Promise<string | null> {
  const tile = findTile(tileId);
  if (!tile?.tryOf) return null;
  const exists = await tryFolderExists(tile.cwd).catch(() => false);
  if (!exists) {
    useTiles.getState().removeTile(tileId);
    return null;
  }
  useTiles.getState().restartTile(tileId);
  const fresh = findTryTile(tilesOf(tile.workspaceId), tile.tryOf.cardId, tile.tryOf.lane);
  if (!fresh) return null;
  if (tile.tryOf.command) await typeWhenReady(fresh.id, lineFor(tile.tryOf.command), seams);
  return fresh.id;
}

/** Show the Try session's tile on the workspace's Terminals (the panel's
 *  Show the session). */
export function showTrySession(tileId: string): boolean {
  const tile = findTile(tileId);
  if (!tile) return false;
  openCenterMode(tile.workspaceId, "terminals");
  useTiles.getState().setExpanded(tile.workspaceId, tile.id);
  return true;
}

/** Stop the card copy's Try session: its command and its shell, children
 *  included (`pty_kill`), and its tile. Nothing when none runs. */
export async function stopTrySession(card: Pick<TryCard, "id" | "workspaceId">, lane?: TryLane | null): Promise<void> {
  const tile = trySessionFor(card, lane);
  if (tile) await useTiles.getState().closeTile(tile.id);
}

/** TI-4: Stop pressed on the card — the session's PTY killed, then its tile
 *  removed. Rejects, leaving the tile, when the kill didn't go through (the
 *  card says so; Show the session can stop it there). */
export async function stopTrySessionOrThrow(
  card: Pick<TryCard, "id" | "workspaceId">,
  lane?: TryLane | null,
): Promise<void> {
  const tile = trySessionFor(card, lane);
  if (!tile) return;
  if (tile.ptyId) await ptyKill(tile.ptyId);
  useTiles.getState().removeTile(tile.id);
}

async function subscribeOutput(tileId: string, cb: (data: Uint8Array) => void): Promise<() => void> {
  return onPtyData((ptyId, data) => {
    const tile = useTiles.getState().getTileByPtyId(ptyId);
    if (tile?.id === tileId) cb(data);
  });
}

/**
 * Feed a Try session's output to `cb` (TI-3's address scanner) from now on.
 * Returns the unsubscribe, which may be called before the listener is up.
 * Output printed before the call is not replayed: pass `onOutput` to
 * `startTrySession` to see all of it.
 */
export function onOutput(tileId: string, cb: (data: Uint8Array) => void): () => void {
  let unsubscribe: (() => void) | null = null;
  let cancelled = false;
  void subscribeOutput(tileId, cb).then((off) => {
    if (cancelled) off();
    else unsubscribe = off;
  });
  return () => {
    cancelled = true;
    unsubscribe?.();
  };
}
