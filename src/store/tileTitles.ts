import { terminalTileRename, terminalTileTitle } from "../ipc";
import { useTiles, type Tile } from "./tileStore";

/**
 * Terminals block P2 (owner, 2026-10-21): a Claude or Codex tile takes its
 * name from its conversation — first the opening words of the member's first
 * message, then the CLI's own title (Claude Code's), read by the backend from
 * the CLI's files on this computer (`terminal_tile_title`). A name the member
 * gives always wins. A tile with no title yet is looked at often; one with a
 * title, now and then (a `/clear` moves it to a new conversation).
 */
const SOON_MS = 8_000;
const LATER_MS = 30_000;

const lastLook = new Map<string, number>();
let timer: ReturnType<typeof setInterval> | null = null;
let busy = false;

function named(tile: Tile): boolean {
  return (tile.kind === "claude" || tile.kind === "codex") && tile.ptyId != null && tile.status === "running";
}

async function look(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const now = Date.now();
    const tiles = Object.values(useTiles.getState().byWorkspace).flatMap((ws) => ws.tiles).filter(named);
    // An ended PTY is never looked at again.
    const running = new Set(tiles.map((t) => t.ptyId!));
    for (const ptyId of [...lastLook.keys()]) if (!running.has(ptyId)) lastLook.delete(ptyId);
    for (const tile of tiles) {
      const ptyId = tile.ptyId!;
      const every = tile.labelSource ? LATER_MS : SOON_MS;
      if (now - (lastLook.get(ptyId) ?? 0) < every) continue;
      lastLook.set(ptyId, now);
      const got = await terminalTileTitle(ptyId).catch(() => null);
      if (!got) continue;
      const store = useTiles.getState();
      const current = store.getTileByPtyId(ptyId);
      if (!current) continue;
      if (got.cliSessionId) store.setCliSession(current.id, got.cliSessionId);
      const name = current.labelSource === "user" ? current.userName : undefined;
      if (name) {
        if (got.followed && !got.conversationNamed) {
          // P2 walk: after a `/clear` the tile is in a new conversation with
          // no name of its own; the member's goes to it (`/rename` again, once
          // idle). A `/resume`d one keeps its own.
          store.markUserLabel(current.id, name);
        } else if (got.titleSource !== "user") {
          // Challenger round 1: a restarted tile's new row takes the member's
          // name too.
          void terminalTileRename(ptyId, name).catch(() => {});
        }
      }
      if (!got.title) continue;
      // Renamed inside the CLI (`/rename`): the member's name too.
      useTiles.getState().setTitleLabel(tile.id, got.title, got.titleSource === "user" ? "user" : "auto");
    }
  } finally {
    busy = false;
  }
}

/** The name a tile still has to pass to its CLI (`/rename`), by PTY. */
export function pendingCliRenameOf(byWorkspace: Record<string, { tiles: Tile[] }>, ptyId: string): string | null {
  for (const ws of Object.values(byWorkspace)) {
    const tile = ws.tiles.find((t) => t.ptyId === ptyId);
    if (tile) return tile.pendingCliRename ?? null;
  }
  return null;
}

/** Look at this tile at the next pass ("Use the automatic name"). */
export function lookSoon(ptyId: string): void {
  lastLook.delete(ptyId);
}

/** App start, beside the other tile subscriptions. Idempotent. */
export function startTileTitles(): void {
  if (timer) return;
  timer = setInterval(() => void look(), 4_000);
}

/** Tests: stop and forget. */
export function stopTileTitlesForTests(): void {
  if (timer) clearInterval(timer);
  timer = null;
  lastLook.clear();
  busy = false;
}

/** Tests: one look now. */
export const lookForTileTitles = look;
