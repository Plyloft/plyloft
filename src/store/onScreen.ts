import type { OnScreen } from "../lib/seenOnScreen";
import { useWorkspaces } from "./workspaceStore";
import { effectiveCenterMode, useUi } from "./uiStore";
import { useTiles } from "./tileStore";

/**
 * QoL 1.168 (F6, D7): what the person is looking at — the active workspace's
 * mode, its open card and its expanded tile (`tileStore`'s
 * `expandedTileId`, the one Terminals draws over the grid) — while Plyloft
 * is in front and visible; null otherwise.
 */
export function onScreenNow(): OnScreen {
  if (typeof document !== "undefined" && (!document.hasFocus() || document.hidden)) return null;
  const activeId = useWorkspaces.getState().activeId;
  if (!activeId) return null;
  const ui = useUi.getState();
  if (ui.allSkillsOpen) return null;
  const mode = effectiveCenterMode(ui.centerMode, activeId);
  return {
    workspaceId: activeId,
    mode,
    cardId: mode === "board" ? (ui.selectedCardId[activeId] ?? null) : null,
    expandedTileId: useTiles.getState().byWorkspace[activeId]?.expandedTileId ?? null,
  };
}
