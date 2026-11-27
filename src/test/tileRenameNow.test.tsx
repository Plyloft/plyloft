// Terminals block P2 walk: a member's tile name reaches Claude as `/rename`
// as soon as its prompt is idle and empty — not at the session's next
// output (in the walk that was after a `/clear`, and named the new
// conversation). After a `/clear` the name is queued again for the new one.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Terminal } from "../components/Terminal";
import { Tile as TileView } from "../components/Tile";
import { useTiles, type Tile } from "../store/tileStore";
import { lookForTileTitles, stopTileTitlesForTests } from "../store/tileTitles";
import { act, renderUi, screen, waitFor } from "./render";

let screenRows: string[] = ["❯ "];
vi.mock("@xterm/xterm", () => {
  // Anything the component calls that the test does not care about is a
  // callable no-op whose properties are no-ops too.
  const deep = (): unknown =>
    new Proxy(function () {}, {
      get: (_t, prop) => (prop === "dispose" ? () => {} : deep()),
      apply: () => deep(),
    });
  class FakeTerm {
    cols = 100;
    rows = 4;
    options: Record<string, unknown> = {};
    buffer = {
      active: {
        baseY: 0,
        get length() {
          return screenRows.length;
        },
        getLine: (i: number) => ({ translateToString: () => screenRows[i] ?? "" }),
      },
    };
    constructor() {
      return new Proxy(this, {
        get(target, prop, receiver) {
          if (prop in target) return Reflect.get(target, prop, receiver);
          if (prop === "then") return undefined;
          return deep();
        },
      });
    }
    write(_data: string | Uint8Array, done?: () => void) {
      done?.();
    }
  }
  return { Terminal: FakeTerm };
});
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} dispose() {} proposeDimensions() { return undefined; } } }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class { dispose() {} onContextLoss() { return { dispose() {} }; } } }));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: class { dispose() {} } }));
vi.mock("@xterm/addon-image", () => ({ ImageAddon: class { dispose() {} } }));

const IDLE = ["────────────", "❯ ", "────────────", "? for shortcuts"];
const bytes = (text: string) => Array.from(new TextEncoder().encode(text));

afterEach(() => {
  stopTileTitlesForTests();
  act(() => useTiles.setState({ byWorkspace: {} }));
  vi.restoreAllMocks();
});

function tile(): Tile {
  return {
    id: "t1",
    workspaceId: "ws",
    kind: "claude",
    ptyId: "pty-1",
    label: "claude",
    cwd: "/code",
    startedAt: Date.now() - 60_000,
    status: "running",
    pendingClose: false,
    expanded: false,
  } as Tile;
}

const typed = (view: ReturnType<typeof renderUi>) =>
  view.tauri.callsOf("pty_write").map((c) => new TextDecoder().decode(new Uint8Array(c.args.data as number[])));

describe("a member's tile name reaches the CLI", () => {
  it("is typed at an idle, empty prompt right away, with no output in between", async () => {
    screenRows = IDLE;
    act(() => useTiles.setState({ byWorkspace: { ws: { tiles: [tile()], expandedTileId: null, detailTileId: null } } }));
    const view = renderUi(<Terminal cmd="claude" cli="claude" workspaceId="ws" readiness="claude" />, {
      fixtures: { pty_spawn: "pty-1", cli_fresh_check: null, pty_resize: null, pty_prompt_state: null, pty_prompt_idle: false, pty_write: null, tile_screen_block: null, terminal_tile_name_passed: null },
    });
    view.tauri.allowUnhandled();
    await waitFor(() => expect(view.tauri.listeners("pty://data")).toBe(1));
    act(() => view.tauri.emit("pty://data", { id: "pty-1", data: bytes("ready") }));
    await act(async () => new Promise((r) => setTimeout(r, 800)));
    expect(typed(view)).toEqual([]);
    // The member names the tile; Claude prints nothing after.
    act(() => useTiles.getState().markUserLabel("t1", "My work"));
    // The Enter is its own write (Codex 0.163 takes text + Enter in one write as a paste).
    await waitFor(() => expect(typed(view)).toEqual(["/rename My work", "\r"]), { timeout: 2000 });
    // Recorded as passed only once submitted.
    await waitFor(() => expect(view.tauri.callsOf("terminal_tile_name_passed").map((c) => c.args)).toEqual([{ ptyId: "pty-1", name: "My work" }]));
    expect(useTiles.getState().byWorkspace.ws.tiles[0].pendingCliRename).toBeUndefined();
  });

  it("is queued again when the tile follows a new conversation after /clear, never into a /resumed one", async () => {
    let clock = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    let look: Record<string, unknown> = { rowId: "row-1", title: "My work", titleSource: "user" };
    const { tauri } = renderUi(<div />, {
      fixtures: {
        terminal_tile_title: ({ ptyId }: Record<string, unknown>) =>
          ptyId === "pty-1" ? look : { rowId: "row-b", title: "Footer", titleSource: "cli" },
        terminal_tile_rename: null,
      },
    });
    act(() =>
      useTiles.setState({
        byWorkspace: {
          ws: {
            tiles: [
              // The member's "My work", shown as "My work · 2" beside another tile's.
              { ...tile(), label: "My work · 2", labelSource: "user", userName: "My work" },
              { ...tile(), id: "t2", ptyId: "pty-2", label: "Footer", labelSource: "auto" },
            ],
            expandedTileId: null,
            detailTileId: null,
          },
        },
      }),
    );
    const pending = () => useTiles.getState().byWorkspace.ws.tiles.map((t) => t.pendingCliRename ?? null);
    const next = async (over: Record<string, unknown>) => {
      look = { ...look, ...over };
      clock += 60_000;
      await act(async () => {
        await lookForTileTitles();
      });
    };
    await next({});
    expect(pending()).toEqual([null, null]);
    // /resume inside Claude: a conversation with a name of its own keeps it.
    await next({ rowId: "row-2", followed: true, conversationNamed: true });
    expect(pending()).toEqual([null, null]);
    // /clear: a fresh conversation takes the member's own name, as typed.
    await next({ rowId: "row-3", followed: true, conversationNamed: false });
    expect(pending()).toEqual(["My work", null]);
    expect(tauri.callsOf("terminal_tile_rename")).toHaveLength(0);
  });

  it("a restart keeps the member's name — on the tile, to the CLI, in the record — and resumes the conversation it is in", async () => {
    let clock = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    act(() =>
      useTiles.setState({
        byWorkspace: {
          ws: {
            tiles: [
              {
                ...tile(),
                label: "My work",
                labelSource: "user",
                userName: "My work",
                // Opened by Resume… on c-1, then a /clear moved it to c-2.
                args: ["--resume", "c-1"],
                cliSessionId: "c-2",
                status: "done",
              },
            ],
            expandedTileId: null,
            detailTileId: null,
          },
        },
      }),
    );
    act(() => useTiles.getState().restartTile("t1"));
    const fresh = useTiles.getState().byWorkspace.ws.tiles[0];
    expect([fresh.label, fresh.labelSource, fresh.pendingCliRename, fresh.args]).toEqual([
      "My work",
      "user",
      "My work",
      ["--resume", "c-2"],
    ]);
    // Its new row is named the member's way once it is looked at.
    act(() => useTiles.getState().setPtyId(fresh.id, "pty-9"));
    act(() =>
      useTiles.setState((st) => ({
        byWorkspace: { ws: { ...st.byWorkspace.ws, tiles: st.byWorkspace.ws.tiles.map((t) => ({ ...t, status: "running" as const })) } },
      })),
    );
    const { tauri } = renderUi(<div />, {
      fixtures: { terminal_tile_title: { rowId: "r9", title: "Claude's", titleSource: "cli", cliSessionId: "c-2" }, terminal_tile_rename: null },
    });
    clock += 60_000;
    await act(async () => {
      await lookForTileTitles();
    });
    expect(tauri.callsOf("terminal_tile_rename").map((c) => c.args)).toEqual([{ ptyId: "pty-9", title: "My work" }]);
    expect(useTiles.getState().byWorkspace.ws.tiles[0].label).toBe("My work");
  });

  it("Use the automatic name drops the member's name, in the record too, and looks again", async () => {
    act(() =>
      useTiles.setState({
        byWorkspace: {
          ws: {
            tiles: [{ ...tile(), label: "My work", labelSource: "user", userName: "My work", pendingCliRename: "My work" }],
            expandedTileId: null,
            detailTileId: null,
          },
        },
      }),
    );
    let title: Record<string, unknown> | null = null;
    const { tauri, user } = renderUi(<TileView tile={useTiles.getState().byWorkspace.ws.tiles[0]} env={null} workspaceCwd="/code" hidden={false} />, {
      fixtures: { terminal_tile_auto_name: { rowId: "r", title: null, titleSource: null }, terminal_tile_title: () => title },
    });
    tauri.allowUnhandled();
    await user.click(screen.getByRole("button", { name: "Use the automatic name" }));
    const t = useTiles.getState().byWorkspace.ws.tiles[0];
    expect([t.labelSource, t.userName, t.pendingCliRename]).toEqual([undefined, undefined, undefined]);
    // Challenger round 2: the default name at once, not the member's until a title turns up.
    expect(t.label).toBe("claude 1");
    await waitFor(() => expect(tauri.callsOf("terminal_tile_auto_name").map((c) => c.args)).toEqual([{ ptyId: "pty-1" }]));
    await waitFor(() => expect(tauri.callsOf("terminal_tile_title")).toHaveLength(1));
    expect(useTiles.getState().byWorkspace.ws.tiles[0].label).toBe("claude 1");
  });

  it("Use the automatic name shows the conversation's current title when the CLI has one", async () => {
    act(() =>
      useTiles.setState({
        byWorkspace: {
          ws: { tiles: [{ ...tile(), label: "My work", labelSource: "user", userName: "My work" }], expandedTileId: null, detailTileId: null },
        },
      }),
    );
    const { tauri, user } = renderUi(<TileView tile={useTiles.getState().byWorkspace.ws.tiles[0]} env={null} workspaceCwd="/code" hidden={false} />, {
      fixtures: {
        terminal_tile_auto_name: { rowId: "r", title: null, titleSource: null },
        terminal_tile_title: { rowId: "r", title: "Parser fix", titleSource: "cli" },
      },
    });
    tauri.allowUnhandled();
    await user.click(screen.getByRole("button", { name: "Use the automatic name" }));
    await waitFor(() => expect(useTiles.getState().byWorkspace.ws.tiles[0].label).toBe("Parser fix"));
    expect(useTiles.getState().byWorkspace.ws.tiles[0].labelSource).toBe("auto");
  });
});
