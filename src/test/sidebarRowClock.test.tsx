// Windows walk (block 10): a fresh Claude tile's sidebar row said "claude 1,
// working" while its header said "Ready". Both read `tileStatusLine`; the row
// read it with the sidebar's ticker, which can lag (a paused ticker, a ConPTY
// scan landing between ticks), the header with the clock at render. The row
// now reads the clock when drawn too, so a scan that says Ready redraws both
// alike.
import { describe, expect, it, vi } from "vitest";
import { WorkspaceSidebar } from "../components/WorkspaceSidebar";
import { useWorkspaces, type Workspace } from "../store/workspaceStore";
import { useTiles } from "../store/tileStore";
import { tileStatusLine } from "../lib/tileStatusLine";
import { READY_QUIET_MS } from "../lib/tileHeaderStatus";
import { act, nextFrame, renderUi, screen, tauri } from "./render";

const ws: Workspace = { id: "a", name: "alpha", cwd: "/Users/someone/code/alpha", createdAt: 1, lastOpenedAt: 1, openFiles: [], activeFile: null };

describe("a live Claude tile's sidebar row", () => {
  it("says what its header says when a scan lands between the sidebar's ticks", async () => {
    tauri().allowUnhandled();
    tauri().fixture("drain_status", { draining: false, startedAt: null });
    tauri().fixture("ship_pending_count", 0);
    tauri().fixture("ship_pending_cards", null);
    tauri().fixture("ship_unverified_count", 0);
    const t0 = Date.now();
    act(() => {
      useWorkspaces.setState({ workspaces: [ws], activeId: "a" });
      useTiles.setState({ byWorkspace: {} } as never);
      const tile = useTiles.getState().addClaudeTile("a", ws.cwd);
      useTiles.setState((s) => ({
        byWorkspace: {
          a: {
            ...s.byWorkspace.a,
            tiles: s.byWorkspace.a.tiles.map((t) =>
              t.id === tile.id ? { ...t, ptyId: "pty-1", status: "running" as const, startedAt: t0 - 60_000 } : t,
            ),
          },
        },
      }));
      // Working first (as a fresh session is, its banner drawing).
      useTiles.getState().markReadiness("pty-1", "claude", { lastOutputAt: t0, matcherIdle: false });
    });
    renderUi(<WorkspaceSidebar env={null} />);
    await nextFrame();
    // The ConPTY scan says Ready a while later — before the sidebar's next
    // tick (only Date moves; no interval runs).
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(t0 + READY_QUIET_MS + 500);
      act(() => useTiles.getState().markReadiness("pty-1", "claude", { lastOutputAt: t0, matcherIdle: true }));
      const tile = useTiles.getState().byWorkspace.a.tiles[0];
      const header = tileStatusLine({
        kind: "claude",
        status: "running",
        startedAt: tile.startedAt,
        readiness: tile.readiness,
        lastOutputAt: tile.lastOutputAt,
        now: Date.now(),
      });
      expect(header.text).toBe("Your turn");
      const row = screen.getByRole("button", { name: new RegExp(`^${tile.label},`) });
      expect(row.getAttribute("aria-label")).toBe(`${tile.label}, your turn`);
    } finally {
      vi.useRealTimers();
    }
  });
});
