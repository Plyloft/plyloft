// Terminals block P2: Claude and Codex tiles take their conversation's
// name; a name the member gives wins, is passed to the CLI only at an empty
// input line, and a label another tile has gets " · 2".
import { afterEach, describe, expect, it } from "vitest";
import { useTiles } from "../store/tileStore";
import { lookForTileTitles, stopTileTitlesForTests } from "../store/tileTitles";
import { act, renderUi } from "./render";

const WS = "ws-1";
afterEach(() => {
  stopTileTitlesForTests();
  act(() => useTiles.setState({ byWorkspace: {} }));
});

function seed() {
  const s = useTiles.getState();
  s.addClaudeTile(WS, "/p");
  s.addClaudeTile(WS, "/p");
  s.addShellTile(WS, "/p");
  const tiles = useTiles.getState().byWorkspace[WS].tiles;
  tiles.forEach((t, i) => {
    s.setPtyId(t.id, `pty-${i}`);
  });
  act(() =>
    useTiles.setState((st) => ({
      byWorkspace: {
        ...st.byWorkspace,
        [WS]: { ...st.byWorkspace[WS], tiles: st.byWorkspace[WS].tiles.map((t) => ({ ...t, status: "running" as const })) },
      },
    })),
  );
  return useTiles.getState().byWorkspace[WS].tiles;
}

const labels = () => useTiles.getState().byWorkspace[WS].tiles.map((t) => t.label);

describe("automatic tile names (P2)", () => {
  it("takes each conversation's title, a shell keeps its own, the same title twice gets · 2", async () => {
    const { tauri } = renderUi(<div />, {
      fixtures: {
        terminal_tile_title: ({ ptyId }: Record<string, unknown>) =>
          ptyId === "pty-2" ? null : { rowId: String(ptyId), title: "Fix the footer", titleSource: "first-message" },
      },
    });
    const [, , shell] = seed();
    await act(async () => {
      await lookForTileTitles();
    });
    expect(labels()).toEqual(["Fix the footer", "Fix the footer · 2", shell.label]);
    expect(tauri.callsOf("terminal_tile_title").map((c) => c.args.ptyId)).toEqual(["pty-0", "pty-1"]);
  });

  it("a member's name wins over later titles and waits for an empty input line to reach the CLI", async () => {
    renderUi(<div />, {
      fixtures: { terminal_tile_title: { rowId: "r", title: "Claude's title", titleSource: "cli" } },
    });
    const [a] = seed();
    act(() => {
      expect(useTiles.getState().renameTile(WS, a.id, "My work").ok).toBe(true);
      useTiles.getState().markUserLabel(a.id, "My work");
    });
    act(() => useTiles.getState().setTitleLabel(a.id, "Claude's title", "auto"));
    expect(labels()[0]).toBe("My work");
    // Renamed inside the CLI: that is the member's too.
    act(() => useTiles.getState().setTitleLabel(a.id, "Renamed in Claude", "user"));
    expect(labels()[0]).toBe("Renamed in Claude");
    // The pending /rename is taken once.
    expect(useTiles.getState().takePendingCliRename("pty-0")).toBe("My work");
    expect(useTiles.getState().takePendingCliRename("pty-0")).toBeNull();
    // A shell gets no /rename.
    const shell = useTiles.getState().byWorkspace[WS].tiles[2];
    act(() => useTiles.getState().markUserLabel(shell.id, "builds"));
    expect(useTiles.getState().takePendingCliRename("pty-2")).toBeNull();
  });
});
