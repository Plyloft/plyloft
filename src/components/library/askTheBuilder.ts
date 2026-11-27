// QoL block 13.2 (D4): **Ask the Builder** from a Library row — a session of
// the member's Builder CLI (Settings › Behaviour's Builder, Claude unless it
// says Codex) in the project folder, its first turn the request the row
// prepared (`lib/askBuilder.ts`), shown at once. An ordinary Claude or Codex
// tile: the PTY behind it is the one every tile spawns (`pty_spawn` →
// `pty.rs::spawn`, the cached PATH, killed on exit), started with the request
// as its positional prompt — interactive, never print mode (hard rule 1).
// Plyloft runs no git here: the Builder does what it is asked, in the
// member's view, asking its own permissions.
import { useSettings } from "../../store/settingsStore";
import { useTiles } from "../../store/tileStore";
import { openCenterMode, useUi } from "../../store/uiStore";
import { ASK_BUILDER_TILE } from "../../lib/askBuilder";

export function askTheBuilder(workspaceId: string, cwd: string, prompt: string): string {
  const vendor = useSettings.getState().settings.behavior?.builderVendor ?? "claude";
  const opts = { args: [prompt], label: ASK_BUILDER_TILE };
  const tiles = useTiles.getState();
  const tile = vendor === "codex" ? tiles.addCodexTile(workspaceId, cwd, opts) : tiles.addClaudeTile(workspaceId, cwd, opts);
  openCenterMode(workspaceId, "terminals");
  useTiles.getState().setExpanded(workspaceId, tile.id);
  // Settings is a modal over the app: the tile would open behind it.
  if (useUi.getState().settingsOverlayOpen) useUi.getState().setSettingsOverlayOpen(false);
  return tile.id;
}
