// A PTY tile whose spawn is refused (a missing program, a refused argument,
// the bundled Knowledge server failing its version check) never gets a PTY,
// so no exit event ever comes. It must end as a crash, with the error in its
// body — not count "Working for Ns" and wait in the Inbox as a live session.
import { describe, expect, it, vi } from "vitest";
import { TileGrid } from "../components/TileGrid";
import { useTiles } from "../store/tileStore";
import { useWorkspaces, type Workspace } from "../store/workspaceStore";
import { waitingSessions } from "../lib/needsYou";
import type { ShellEnvInfo } from "../ipc";
import { act, renderUi, waitFor, within } from "./render";
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

const REFUSAL =
  "bundled Knowledge server version check failed (exit code 0xc0000135)";

describe("a tile whose spawn failed", () => {
  it("says Crashed, shows the error and does not wait in the Inbox", async () => {
    written.length = 0;
    const stub = tauri();
    stub.allowUnhandled();
    stub.fixture("pty_spawn", () => {
      throw REFUSAL;
    });
    const t = useTiles.getState().addClaudeTile(ws.id, ws.cwd);
    act(() => useWorkspaces.setState({ workspaces: [ws], activeId: ws.id }));
    renderUi(<TileGrid env={env} workspace={ws} />);

    await waitFor(() => {
      const tile = useTiles.getState().byWorkspace[ws.id]?.tiles[0];
      expect(tile?.status).toBe("crashed");
    });
    expect(stub.callsOf("pty_spawn")).toHaveLength(1);
    const tile = useTiles.getState().byWorkspace[ws.id]!.tiles[0];
    expect(tile.id).toBe(t.id);
    expect(tile.exitCode ?? null).toBeNull();
    expect(tile.ptyId).toBeNull();

    const header = document.querySelector(".tile-header") as HTMLElement;
    await waitFor(() =>
      expect(within(header).getByRole("status").textContent).toBe("Stopped unexpectedly"),
    );
    // The same Restart a crashed session offers.
    expect(within(header).getByRole("button", { name: "Restart" })).toBeTruthy();
    // QoL 1.168 block 8 (A5): plain words first, the raw text after them.
    expect(written.join("\n")).toContain("This session didn't start.");
    expect(written.join("\n")).toContain(REFUSAL);
    expect(written.join("\n")).not.toContain("[spawn failed");

    // Long after the silence window, it is still not a waiting session.
    const later = Date.now() + 60_000;
    expect(
      waitingSessions({
        tilesByWorkspace: useTiles.getState().byWorkspace,
        builders: {},
        cardTitle: () => null,
        now: later,
      }),
    ).toEqual([]);
  });

  // 1.176.0 R3: the Claude CLI isn't on disk even after the backend looked
  // again. No spawn is tried, the tile ends as a crash with today's words,
  // and the raw line is the backend's words, not its typed shape.
  it("says the program didn't start when the CLI is gone, without spawning", async () => {
    written.length = 0;
    const stub = tauri();
    stub.allowUnhandled();
    const gone =
      'PLY_CLI_UNAVAILABLE_V1:{"tool":"claude","was":"/usr/local/bin/claude"}\n' +
      "claude: not found in PATH. Plyloft looked for it again; it was at /usr/local/bin/claude.";
    stub.fixture("cli_fresh_check", () => {
      throw gone;
    });
    stub.fixture("pty_spawn", "pty-1");
    useTiles.getState().addClaudeTile(ws.id, ws.cwd);
    act(() => useWorkspaces.setState({ workspaces: [ws], activeId: ws.id }));
    renderUi(<TileGrid env={env} workspace={ws} />);

    await waitFor(() => {
      const tile = useTiles.getState().byWorkspace[ws.id]?.tiles[0];
      expect(tile?.status).toBe("crashed");
    });
    expect(stub.callsOf("cli_fresh_check")[0]?.args).toEqual({ tool: "claude" });
    expect(stub.callsOf("pty_spawn")).toHaveLength(0);
    const text = written.join("\n");
    expect(text).toContain("This session didn't start.");
    expect(text).toContain("The program didn't start.");
    expect(text).toContain("claude: not found in PATH");
    expect(text).not.toContain("PLY_CLI_UNAVAILABLE_V1");
  });

  // R3 review 3: a tile closed (or a superseded effect) while its check is
  // still out starts nothing, and a refusal arriving after writes nothing.
  it("starts nothing when the tile goes away during its check", async () => {
    written.length = 0;
    const stub = tauri();
    stub.allowUnhandled();
    let pass!: () => void;
    let refuse!: (e: unknown) => void;
    const checks: Promise<void>[] = [
      new Promise<void>((resolve) => (pass = resolve)),
      new Promise<void>((_, reject) => (refuse = reject)),
    ];
    let n = 0;
    stub.fixture("cli_fresh_check", () => checks[n++]);
    stub.fixture("pty_spawn", "pty-1");
    useTiles.getState().addClaudeTile(ws.id, ws.cwd);
    useTiles.getState().addCodexTile(ws.id, ws.cwd);
    act(() => useWorkspaces.setState({ workspaces: [ws], activeId: ws.id }));
    const view = renderUi(<TileGrid env={env} workspace={ws} />);
    await waitFor(() => expect(stub.callsOf("cli_fresh_check").length).toBeGreaterThan(0));
    const before = written.length;
    view.unmount();
    pass();
    refuse("PLY_CLI_UNAVAILABLE_V1:{\"tool\":\"codex\",\"was\":null}\ncodex: not found in PATH.");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stub.callsOf("pty_spawn")).toHaveLength(0);
    expect(written.slice(before).join("\n")).not.toContain("didn't start");
  });

  // R3: a Claude tile is spawned as Claude by its kind; the window's own
  // path is not sent as the program, and a fresh snapshot with another path
  // does not restart it.
  it("spawns a Claude tile by its kind and keeps it through a new snapshot", async () => {
    written.length = 0;
    const stub = tauri();
    stub.allowUnhandled();
    stub.fixture("cli_fresh_check", null);
    stub.fixture("pty_spawn", "pty-1");
    useTiles.getState().addClaudeTile(ws.id, ws.cwd);
    act(() => useWorkspaces.setState({ workspaces: [ws], activeId: ws.id }));
    const view = renderUi(<TileGrid env={env} workspace={ws} />);

    await waitFor(() => expect(stub.callsOf("pty_spawn")).toHaveLength(1));
    const spawn = stub.callsOf("pty_spawn")[0].args;
    expect(spawn.cli).toBe("claude");
    expect(spawn.cmd).toBe("claude");
    const checked = stub.calls.findIndex((c) => c.cmd === "cli_fresh_check");
    const spawned = stub.calls.findIndex((c) => c.cmd === "pty_spawn");
    expect(checked).toBeGreaterThanOrEqual(0);
    expect(checked).toBeLessThan(spawned);

    view.rerender(<TileGrid env={{ ...env, claudePath: "/Users/someone/.local/bin/claude" }} workspace={ws} />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stub.callsOf("pty_spawn")).toHaveLength(1);
    expect(stub.callsOf("pty_kill")).toHaveLength(0);
  });
});
