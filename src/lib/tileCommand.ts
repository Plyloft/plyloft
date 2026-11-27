/**
 * UX language card 8 (GH #103): when a shell tile is ready to be typed into,
 * and what "a command a person typed" is on the wire.
 *
 * Pure — no store, no Tauri — so `tileCommand.test.ts` runs the timing rule
 * under node. `lib/runInTile.ts` is the part that touches the stores.
 */

/** How long to wait for the shell to say something before typing anyway. A
 *  login shell that prints no banner never produces a first byte, so the wait
 *  has to end by itself. */
export const PROMPT_GRACE_MS = 1200;
/** When even the PTY never arrives, give up rather than wait for ever. */
export const SPAWN_LIMIT_MS = 10000;
/** How often the wait looks again. */
export const POLL_MS = 50;

/** What the wait needs to know about a tile. */
export interface TileProgress {
  ptyId: string | null;
  lastOutputAt?: number;
}

/**
 * Is the shell ready to be typed into?
 *
 * Not before the PTY exists: a write with no `ptyId` is dropped on the floor
 * (`writeToTilePty` returns silently), which is how a command typed too early
 * disappears with no trace. After that, the first byte of output is the
 * shell's prompt — and if none comes within the grace window, the shell has
 * simply printed nothing and the input queue will hold what is typed.
 */
export function readyToType(tile: TileProgress | null, waitedMs: number): boolean {
  if (!tile?.ptyId) return false;
  return tile.lastOutputAt != null || waitedMs >= PROMPT_GRACE_MS;
}

/** The bytes for a command a person would have typed: the line, then Return.
 *
 *  Plain bytes, not a bracketed paste. The shell this runs in may be the very
 *  one Diagnostics is complaining about — macOS `/bin/bash` 3.2 has no paste
 *  mode, and a bracketed paste there is typed literally as `[200~gh auth
 *  login[201~`. */
export function commandBytes(command: string): Uint8Array {
  const line = command.trim();
  // One line, always. A newline inside would submit the first part and leave
  // the rest at the shell's prompt for the person to send by accident — and
  // nothing Ply offers here is more than one command (review 1, finding 14).
  if (/[\r\n]/.test(line)) {
    throw new Error(`a tile command is one line: ${JSON.stringify(command)}`);
  }
  return new TextEncoder().encode(`${line}\r`);
}

