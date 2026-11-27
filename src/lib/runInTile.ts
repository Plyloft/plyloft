/**
 * UX language card 8 (GH #103; BOARDS.md §5 "Settings › Advanced ›
 * Diagnostics"): open a shell tile in the active workspace **with the command
 * already running**.
 *
 * `gh auth login` asks questions and opens a browser; `brew install gh` writes
 * outside Ply. Neither is Ply's to do, so Diagnostics does not pretend to fix
 * them — it does the part that is Ply's: opening the terminal, in the right
 * workspace, with the command typed and submitted.
 *
 * **It spawns nothing itself.** The tile is an ordinary shell tile
 * (`tileStore.addShellTile`), and the PTY behind it is the one `Terminal`
 * spawns through `pty_spawn` → `pty.rs::spawn`: the cached PATH from
 * `shell_env::init()`, registered in `PtyRegistry`, killed with every other
 * child on `ExitRequested` (hard rules 1, 2 and 4). There is no second spawn
 * path to keep in step — `runInTile.test.ts` holds this file to that by
 * reading it.
 *
 * The command is then **typed into** that shell, not passed as `-c`: a tile
 * that ran `gh auth login` and exited would close the moment the login needed
 * a second step, and the person would have nowhere to see what it said.
 */

import { useTiles, writeToTilePty } from "../store/tileStore";
import { openCenterMode } from "../store/uiStore";
import type { TryOf } from "./tryTile";
import {
  POLL_MS,
  SPAWN_LIMIT_MS,
  commandBytes,
  readyToType,
  type TileProgress,
} from "./tileCommand";

/** The tile of `tileId`, wherever it is. */
function find(tileId: string): TileProgress | null {
  for (const ws of Object.values(useTiles.getState().byWorkspace)) {
    const found = ws.tiles.find((t) => t.id === tileId);
    if (found) return found;
  }
  return null;
}

/** How a line reaches a tile: the line, or — Try it (TI-2) — a function of
 *  the tile's shell that gives it (`tryTile.ts::tryCommandForShell`). */
export type TileLine = string | ((shell: string | undefined) => string | Promise<string>);

/**
 * Type `command` into the shell tile `tileId` once it is ready (its PTY
 * exists and its prompt printed, or the grace ran out). Rejects when the
 * tile closed first or its PTY never arrived.
 */
export async function typeWhenReady(
  tileId: string,
  command: TileLine,
  opts: {
    beforeType?: (tileId: string) => Promise<void> | void;
    /** Try it (Windows walk): the line as it is about to be typed — the
     *  form that runs (`npm.cmd …` in PowerShell), not the one asked for. */
    onLine?: (line: string) => void;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {},
): Promise<void> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());
  const started = now();
  for (;;) {
    const waited = now() - started;
    const current = find(tileId);
    if (!current) throw new Error("the tile was closed before the command could start");
    if (readyToType(current, waited)) break;
    if (waited >= SPAWN_LIMIT_MS) {
      throw new Error("the shell tile did not start, so the command was not run");
    }
    await sleep(POLL_MS);
  }
  if (opts.beforeType) await opts.beforeType(tileId);
  const shell = (find(tileId) as { command?: string } | null)?.command;
  const line = typeof command === "function" ? await command(shell) : command;
  opts.onLine?.(line);
  await writeToTilePty(tileId, commandBytes(line));
}

/**
 * Open a shell tile on the active workspace's terminals, show it, and type
 * `command` into it. Resolves with the tile's id once the command has been
 * sent, and rejects when the PTY never arrived — the caller puts that on the
 * page rather than leaving an empty tile behind.
 */
export async function runInShellTile(opts: {
  workspaceId: string;
  cwd: string;
  /** The line to type, or — Try it (TI-2) — the line for the tile's shell,
   *  asked once the tile exists. */
  command: TileLine;
  /** Try it (TI-2): the tile is that card copy's Try session, titled
   *  `title` ("Try · <card title>"); its PTY gets `PORT`/`BROWSER=none`. */
  kind?: "shell" | "try";
  tryOf?: TryOf;
  title?: string;
  /** Called with the tile's id before the command is typed, so an output
   *  subscription sees everything the command prints. */
  beforeType?: (tileId: string) => Promise<void> | void;
  /** Called with the line just before it is typed (`typeWhenReady`). */
  onLine?: (line: string) => void;
  /** Try it (TI-4): false keeps the person where they are — the card page
   *  shows the Try session's preview, and its Show the session opens the
   *  tile. Default true: the tile is shown at once. */
  reveal?: boolean;
  /** Test seam. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<string> {
  if (opts.kind === "try" && !opts.tryOf) {
    throw new Error("a Try session names its card");
  }
  const tile = useTiles.getState().addShellTile(
    opts.workspaceId,
    opts.cwd,
    opts.kind === "try" ? { tryOf: opts.tryOf, label: opts.title } : undefined,
  );
  // The tile is worth seeing before the command lands in it: the person is
  // about to be asked questions by whatever is about to run.
  if (opts.reveal !== false) {
    openCenterMode(opts.workspaceId, "terminals");
    useTiles.getState().setExpanded(opts.workspaceId, tile.id);
  }
  await typeWhenReady(tile.id, opts.command, opts);
  return tile.id;
}
