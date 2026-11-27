// QoL 1.168 (Challenger P1): the tile expanded over the grid is the one on
// screen — read from the store as Terminals sets it (`setExpanded` →
// `expandedTileId`); the hidden tiles' finished turns stay unseen.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "./render";
import { useWorkspaces, type Workspace } from "../store/workspaceStore";
import { useTiles, type Tile } from "../store/tileStore";
import { useUi } from "../store/uiStore";
import { useTileSeen } from "../store/tileSeenStore";
import { onScreenNow } from "../store/onScreen";
import { tilesSeenOnScreen } from "../lib/seenOnScreen";
import { waitingSessions } from "../lib/needsYou";

const NOW = Date.now();
const ws: Workspace = { id: "a", name: "alpha", cwd: "/code/alpha", createdAt: 1, lastOpenedAt: 1, openFiles: [], activeFile: null };

function turned(id: string): Tile {
  return {
    id, workspaceId: "a", kind: "claude", ptyId: `pty-${id}`, label: id, cwd: "/code/alpha",
    startedAt: NOW - 120_000, status: "running", pendingClose: false, expanded: false,
    lastOutputAt: NOW - 60_000, promptBoxIdle: true,
    readiness: { lastOutputAt: NOW - 60_000, matcherIdle: true, leftReadyAt: NOW - 90_000 },
    submittedAt: NOW - 90_000,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("seen on screen", () => {
  it("an expanded tile is seen; the hidden ones that finished stay unseen", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    act(() => {
      useWorkspaces.setState({ workspaces: [ws], activeId: "a" });
      useTiles.setState({ byWorkspace: { a: { tiles: [turned("t1"), turned("t2"), turned("t3")], expandedTileId: null, detailTileId: null } } });
      useUi.getState().setCenterMode("a", "terminals");
      useTiles.getState().setExpanded("a", "t2");
    });
    expect(useTiles.getState().byWorkspace.a.expandedTileId).toBe("t2");
    const waiting = () =>
      waitingSessions({ tilesByWorkspace: useTiles.getState().byWorkspace, builders: {}, cardTitle: () => null, now: NOW, tileSeen: useTileSeen.getState().seen });
    const screen = onScreenNow();
    expect(screen?.expandedTileId).toBe("t2");
    act(() => useTileSeen.getState().markSeen(tilesSeenOnScreen(waiting(), screen)));
    expect(waiting().map((s) => s.id)).toEqual(["tile:t1", "tile:t3"]);

    // Back to the grid: all of them are on screen.
    act(() => useTiles.getState().setExpanded("a", null));
    act(() => useTileSeen.getState().markSeen(tilesSeenOnScreen(waiting(), onScreenNow())));
    expect(waiting()).toEqual([]);
  });

  it("nothing is on screen while Plyloft is not in front", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    act(() => useWorkspaces.setState({ workspaces: [ws], activeId: "a" }));
    expect(onScreenNow()).toBeNull();
  });
});
