// 1.174.0 walk G3b: a new tile's number is the highest in use + 1, so two
// tiles never share a name after one closes ("Same folder as codex 3" must
// name one tile).
import { afterEach, describe, expect, it } from "vitest";
import { useTiles } from "../store/tileStore";
import { act } from "./render";

const WS = "ws-labels";
const labels = () => (useTiles.getState().byWorkspace[WS]?.tiles ?? []).map((t) => t.label);

afterEach(() => act(() => useTiles.setState({ byWorkspace: {} })));

describe("tile numbers", () => {
  it("after codex 1 closes, the next two are codex 4 and codex 5, never a second codex 3", () => {
    act(() => {
      const s = useTiles.getState();
      s.addCodexTile(WS, "/p");
      s.addCodexTile(WS, "/p");
      s.addCodexTile(WS, "/p");
    });
    expect(labels()).toEqual(["codex 1", "codex 2", "codex 3"]);
    act(() => useTiles.getState().removeTile(useTiles.getState().byWorkspace[WS].tiles[0].id));
    act(() => {
      useTiles.getState().addCodexTile(WS, "/p/.plyloft-worktrees/copy-0a0b0c0d");
      useTiles.getState().addCodexTile(WS, "/p");
    });
    expect(labels()).toEqual(["codex 2", "codex 3", "codex 4", "codex 5"]);
    expect(new Set(labels()).size).toBe(labels().length);
  });

  it("each kind counts its own; a renamed tile doesn't hold a number", () => {
    act(() => {
      const s = useTiles.getState();
      s.addClaudeTile(WS, "/p");
      s.addClaudeTile(WS, "/p", { label: "Dark mode", labelSource: "user" });
      s.addShellTile(WS, "/p");
      s.addClaudeTile(WS, "/p");
    });
    expect(labels()).toEqual(["claude 1", "Dark mode", "shell 1", "claude 2"]);
  });
});
