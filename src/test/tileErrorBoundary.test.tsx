// 2026-09-30 (Challenger minor): one boundary per tile. A tile that fails to
// draw shows its own ErrorBlock and takes only itself down — the other
// tiles' terminals stay mounted and their PTYs are never killed.
import { describe, expect, it, vi } from "vitest";

const boom = vi.hoisted(() => ({ on: false }));
vi.mock("../lib/tileStatusLine", async (orig) => {
  const real = await orig<typeof import("../lib/tileStatusLine")>();
  return {
    ...real,
    tileStatusLine: (input: Parameters<typeof real.tileStatusLine>[0]) => {
      // The bad tile is the one marked busy below.
      if (boom.on && input.sessionBusy === true) throw new Error("tile header broke");
      return real.tileStatusLine(input);
    },
  };
});

import { TileGrid } from "../components/TileGrid";
import { useTiles } from "../store/tileStore";
import { useWorkspaces, type Workspace } from "../store/workspaceStore";
import type { ShellEnvInfo } from "../ipc";
import { act, renderUi, screen, waitFor, within } from "./render";
import { tauri } from "./tauri";

// xterm draws on a canvas jsdom does not have. The fake keeps what the tile
// writes and answers every other call with a disposable no-op.
const written: string[] = [];
vi.mock("@xterm/xterm", () => {
  const noop = () => ({ dispose() {} });
  class FakeTerm {
    cols = 80;
    rows = 24;
    textarea = null;
    options: Record<string, unknown> = {};
    modes = { bracketedPasteMode: false };
    parser = { registerOscHandler: noop };
    buffer = { active: { type: "normal", length: 0, baseY: 0, viewportY: 0, getLine: () => undefined } };
    constructor() {
      return new Proxy(this, {
        get(target, prop, receiver) {
          if (prop in target) return Reflect.get(target, prop, receiver);
          return noop;
        },
      });
    }
    writeln(line: string) {
      written.push(line);
    }
    write(data: string, done?: () => void) {
      written.push(data);
      done?.();
    }
  }
  return { Terminal: FakeTerm };
});
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} dispose() {} proposeDimensions() { return undefined; } } }));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: class { dispose() {} } }));
vi.mock("@xterm/addon-image", () => ({ ImageAddon: class { dispose() {} } }));
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class { onContextLoss() {} dispose() {} },
}));

const ws: Workspace = {
  id: "w1",
  name: "Lyra",
  cwd: "/Users/someone/code/lyra",
  createdAt: 1,
  lastOpenedAt: 1,
  openFiles: [],
  activeFile: null,
};

const env: ShellEnvInfo = {
  path: "/usr/bin",
  shell: "/bin/zsh",
  claudePath: "/usr/local/bin/claude",
  claudeVersion: "2.1.232",
  codexPath: "/usr/local/bin/codex",
  codexVersion: "0.151.0",
  codexHealthy: true,
  gitPath: "/usr/bin/git",
  gitVersion: "2.50.1",
  ghPath: null,
  ghVersion: null,
  supportsStreamJson: true,
  probeError: null,
};

describe("a tile that fails to draw", () => {
  it("shows its own ErrorBlock and leaves the other tiles' terminals running", async () => {
    const stub = tauri();
    stub.allowUnhandled();
    let n = 0;
    stub.fixture("pty_spawn", () => `pty-${++n}`);
    const good = useTiles.getState().addShellTile(ws.id, ws.cwd);
    const bad = useTiles.getState().addShellTile(ws.id, ws.cwd);
    act(() => useWorkspaces.setState({ workspaces: [ws], activeId: ws.id }));
    renderUi(<TileGrid env={env} workspace={ws} />);
    await waitFor(() => expect(stub.callsOf("pty_spawn")).toHaveLength(2));
    await waitFor(() => {
      const tiles = useTiles.getState().byWorkspace[ws.id]!.tiles;
      expect(tiles.every((t) => t.ptyId != null)).toBe(true);
    });
    const goodPty = useTiles.getState().byWorkspace[ws.id]!.tiles.find((t) => t.id === good.id)!.ptyId;

    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    boom.on = true;
    act(() =>
      useTiles.setState((s) => ({
        byWorkspace: {
          ...s.byWorkspace,
          [ws.id]: {
            ...s.byWorkspace[ws.id]!,
            tiles: s.byWorkspace[ws.id]!.tiles.map((t) =>
              t.id === bad.id ? { ...t, sessionBusy: true } : t,
            ),
          },
        },
      })),
    );
    quiet.mockRestore();

    const block = await screen.findByRole("group", { name: `${bad.label} could not be shown.` });
    expect(block.textContent).toContain("The other terminals and your files are as they were.");
    expect(within(block).getByRole("button", { name: "Close tile" })).toBeTruthy();
    // The good tile is still drawn, and its PTY was never killed.
    expect(document.querySelectorAll(".tile")).toHaveLength(1);
    const killed = stub.callsOf("pty_kill").map((c) => c.args.id);
    expect(killed).not.toContain(goodPty);
    boom.on = false;
  });
});
