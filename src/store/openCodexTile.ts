import type { ShellEnvInfo } from "../ipc";
import { decideCodexLaunch, type CodexTileKind } from "../lib/codexTileLaunch";
import { cliNotStartingSentence } from "../lib/cliNotStarting";
import { openRepair } from "../lib/openRepair";
import { useTiles, type CliTileOpts, type Tile } from "./tileStore";
import { pushToast } from "./toastStore";

/**
 * v1.103.0 (D1): one way to open a Codex tile, of either kind — the Terminals
 * page's New and empty-page button, ⌘⇧X and the command search (post-1.167
 * block A: the shortcut and the search reach it with no Terminals page
 * mounted yet, a workspace still warming). The kinds differ only in their
 * gate (D3) and their store action: a `codex` tile is a PTY running the
 * CLI's own TUI, a `codex-chat` tile an App Server session.
 */
export function openCodexTile(
  workspaceId: string,
  cwd: string,
  env: ShellEnvInfo | null | undefined,
  tile: CodexTileKind = "codex",
  /** Terminals block P4: a `codex` tile that resumes a conversation. */
  opts?: CliTileOpts,
): Tile | null {
  const decision = decideCodexLaunch(tile, env ?? null);
  if (decision.kind === "unavailable") return null;
  if (decision.kind === "broken") {
    // 1.176.0 R7: the state in plain words, and Repair as the press.
    pushToast({
      kind: "error",
      title: "Codex won't start",
      body: cliNotStartingSentence("codex"),
      action: { label: "Repair Codex", onClick: () => void openRepair("codex") },
    });
    return null;
  }
  // 1.176.0 R5: the tile opens now and starts no update; one the backend
  // runs while Codex was idle makes the tile's start wait, saying so.
  const tiles = useTiles.getState();
  return tile === "codex" ? tiles.addCodexTile(workspaceId, cwd, opts) : tiles.addCodexChatTile(workspaceId, cwd);
}
