import { ptyKill, terminalResumeCheck } from "../ipc";
import { FOLDER_GONE, OPEN_ELSEWHERE } from "../lib/terminalConversations";
import { machineWords } from "../lib/platform";
import { pushToast } from "./toastStore";
import { confirmSheet } from "./confirmStore";
import { tileCloseAsks } from "./tileActions";
import { RESTART_WHILE_WORKING } from "../lib/themeRestart";
import { useTiles, type RestartHow, type Tile } from "./tileStore";
import { focusTile, showTile } from "./tileActions";

/**
 * QoL 1.168 (block 4, D2, owner): an ended Claude or Codex tile starts again
 * in the conversation it was in — **Continue** (`claude --resume <id>`,
 * `codex resume <id>`) — through the same checks as Resume…
 * (`terminal_resume_check`); **Start fresh** begins a new one. A shell
 * restarts as it always did. The keyboard goes to the new tile (a click).
 */

/** What the tile's main restart button does. */
export function canContinue(tile: Pick<Tile, "kind" | "cliSessionId">): boolean {
  return (tile.kind === "claude" || tile.kind === "codex") && !!tile.cliSessionId;
}

/** The words a Continue that can't happen says, and whether it started
 *  fresh instead. */
export const NOTHING_TO_CONTINUE =
  "Nothing was said in that conversation yet, so there was nothing to continue: a new one started.";

function restart(tileId: string, how?: RestartHow): string | null {
  const id = useTiles.getState().restartTile(tileId, how);
  if (id) focusTile(id);
  return id;
}

/** Start the tile again: `continue` (the default for a Claude/Codex tile
 *  with a conversation) or `fresh`. Resolves to the new tile's id, or null
 *  when nothing started (a toast said why, or another tile was shown). */
export async function restartSession(tile: Tile, how: RestartHow | "auto" = "auto"): Promise<string | null> {
  const cli = tile.kind === "claude" || tile.kind === "codex" ? tile.kind : null;
  if (!cli) return restart(tile.id);
  const going: RestartHow = how === "auto" ? (canContinue(tile) ? "continue" : "fresh") : how;
  if (going === "fresh" || !tile.cliSessionId) return restart(tile.id, "fresh");
  const check = await terminalResumeCheck(cli, tile.cliSessionId, tile.cwd).catch(() => null);
  if (!check) {
    pushToast({ kind: "error", title: "Plyloft couldn't check this conversation", body: "Try Continue again in a moment, or Start fresh." });
    return null;
  }
  switch (check.kind) {
    case "ready":
      return restart(tile.id, "continue");
    case "inTile": {
      // Another tile already continued it: that one is shown, not a second.
      const live = useTiles.getState().getTileByPtyId(check.ptyId);
      if (live) {
        showTile(live.workspaceId, live.id);
        return null;
      }
      pushToast({ kind: "warn", title: "This conversation is open somewhere else", body: machineWords(OPEN_ELSEWHERE) });
      return null;
    }
    case "elsewhere":
      pushToast({ kind: "warn", title: "This conversation is open somewhere else", body: machineWords(OPEN_ELSEWHERE) });
      return null;
    case "folderGone":
      pushToast({ kind: "error", title: "This session can't start again here", body: FOLDER_GONE });
      return null;
    case "conversationGone": {
      // Claude saves a conversation at its first message: a session closed
      // before one has nothing to resume.
      const id = restart(tile.id, "fresh");
      if (id) pushToast({ kind: "info", title: "Started a new conversation", body: NOTHING_TO_CONTINUE });
      return id;
    }
  }
}

/** How long a restart waits for the old session's exit before going on. */
const EXIT_WAIT_MS = 5_000;

function tileNow(tileId: string): Tile | undefined {
  for (const ws of Object.values(useTiles.getState().byWorkspace)) {
    const t = ws.tiles.find((x) => x.id === tileId);
    if (t) return t;
  }
  return undefined;
}

const ended = (t: Tile | undefined) => t != null && (t.status === "done" || t.status === "crashed");

/**
 * 1.168.1 (#6, Windows): Restart on a running Claude tile — the session is
 * stopped, then continued in the same conversation (`restartSession`'s
 * Continue, `--resume <id>`), so it starts with the theme Plyloft has now.
 * Resolves to the new tile's id, or null.
 */
export async function restartRunningSession(tile: Tile): Promise<string | null> {
  if (!ended(tile) && tile.ptyId) {
    await ptyKill(tile.ptyId).catch(() => {});
    if (!ended(tileNow(tile.id))) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          unsubscribe();
          resolve();
        }, EXIT_WAIT_MS);
        const unsubscribe = useTiles.subscribe(() => {
          if (ended(tileNow(tile.id))) {
            clearTimeout(timer);
            unsubscribe();
            resolve();
          }
        });
      });
    }
    // The exit never reached the tile (its terminal may be hidden): the
    // process is gone all the same.
    if (!ended(tileNow(tile.id))) useTiles.getState().markExited(tile.id, null);
  }
  const latest = tileNow(tile.id);
  return latest ? restartSession(latest, "continue") : null;
}

/** 1.168.1 (#6, Windows): the theme line's Restart — asked first when the
 *  session is working or waiting on the member (what closing it would ask,
 *  `tileCloseAsks`), then [`restartRunningSession`]. Null when not restarted. */
export async function restartForTheme(tile: Tile): Promise<string | null> {
  const latest = tileNow(tile.id) ?? tile;
  if ((await tileCloseAsks(latest, latest.status)) && !(await confirmSheet({ ...RESTART_WHILE_WORKING }))) {
    return null;
  }
  return restartRunningSession(latest);
}
