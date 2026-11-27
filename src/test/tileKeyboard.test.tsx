// QoL 1.168 block 3 (D1, A1, D4, D8): a tile a member opens is on screen with
// the keyboard in it, ⌘⇧] moves between tiles, and closing asks only when
// something would be lost.
import { describe, expect, it, vi } from "vitest";
import { TileGrid } from "../components/TileGrid";
import { useTiles } from "../store/tileStore";
import { useWorkspaces, type Workspace } from "../store/workspaceStore";
import { useUi } from "../store/uiStore";
import {
  currentTileId,
  focusAdjacentTile,
  focusTile,
  lastFocusedTileForTests,
  openDefaultTile,
  openNewTile,
  requestCloseCurrentTile,
} from "../store/tileActions";
import { useSettings } from "../store/settingsStore";
import type { ShellEnvInfo } from "../ipc";
import { act, renderUi, screen, waitFor } from "./render";

// The terminal body: only xterm's input, which is what focus goes to.
vi.mock("../components/Terminal", () => ({
  Terminal: () => <textarea className="xterm-helper-textarea" aria-label="Terminal input" />,
}));
vi.mock("../components/CodexSession", () => ({ CodexSession: () => <div data-testid="codex" /> }));

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
  codexPath: null,
  codexVersion: null,
  codexHealthy: false,
  gitPath: "/usr/bin/git",
  gitVersion: "2.50.1",
  ghPath: null,
  ghVersion: null,
  supportsStreamJson: true,
  probeError: null,
};

const tiles = () => useTiles.getState().byWorkspace[ws.id]?.tiles ?? [];

function setup(fixtures: Record<string, (args: Record<string, unknown>) => unknown> = {}) {
  act(() => useWorkspaces.setState({ workspaces: [ws], activeId: ws.id }));
  act(() => useUi.getState().setCenterMode(ws.id, "board"));
  // E7 round 1: the empty page reads Resume…'s list (none here).
  return renderUi(<TileGrid env={env} workspace={ws} />, { fixtures: { terminal_conversations: [], ...fixtures } });
}

/** Let the focus requests run their frames. */
async function frames(n = 6) {
  for (let i = 0; i < n; i++) {
    await act(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
  }
}

function inputOf(tileId: string): HTMLElement {
  return document.querySelector(`[data-tile-id="${tileId}"] .xterm-helper-textarea`) as HTMLElement;
}

describe("tiles by keyboard", () => {
  it("a new tile opens Terminals with the keyboard in it", async () => {
    setup();
    let id = "";
    act(() => {
      id = openNewTile(ws.id, ws.cwd, "claude", env)!.id;
    });
    expect(useUi.getState().centerMode[ws.id]).toBe("terminals");
    await frames();
    expect(document.activeElement).toBe(inputOf(id));
  });

  it("⌘T opens the kind Settings chooses, a shell when that one is not installed", () => {
    setup();
    act(() =>
      useSettings.setState((s) => ({
        settings: { ...s.settings, terminals: { ...s.settings.terminals, defaultNewPaneKind: "claude" } },
      })),
    );
    act(() => void openDefaultTile(ws.id, ws.cwd, env));
    act(() =>
      useSettings.setState((s) => ({
        settings: { ...s.settings, terminals: { ...s.settings.terminals, newTileKind: "codex" } },
      })),
    );
    // Codex is not installed in this env.
    act(() => void openDefaultTile(ws.id, ws.cwd, env));
    expect(tiles().map((t) => t.kind)).toEqual(["claude", "shell"]);
  });

  it("⌘⇧] and ⌘⇧[ move between tiles, round the end", async () => {
    const a = useTiles.getState().addShellTile(ws.id, ws.cwd);
    const b = useTiles.getState().addShellTile(ws.id, ws.cwd);
    setup();
    act(() => useUi.getState().setCenterMode(ws.id, "terminals"));
    act(() => inputOf(a.id).focus());
    act(() => void focusAdjacentTile(ws.id, 1));
    await frames();
    expect(document.activeElement).toBe(inputOf(b.id));
    act(() => void focusAdjacentTile(ws.id, 1));
    await frames();
    expect(document.activeElement).toBe(inputOf(a.id));
    act(() => void focusAdjacentTile(ws.id, -1));
    await frames();
    expect(document.activeElement).toBe(inputOf(b.id));
  });

  // H2: ⌘2 (a switch that focuses) then ⌘P — what the member types in
  // the field is not taken back by the focus request.
  it("a focus request gives way to a shortcut and the field it opens", async () => {
    const a = useTiles.getState().addShellTile(ws.id, ws.cwd);
    setup();
    act(() => useUi.getState().setCenterMode(ws.id, "terminals"));
    const field = document.createElement("input");
    document.body.appendChild(field);
    act(() => field.focus());
    act(() => focusTile(a.id));
    // ⌘P on the next frame, then its field takes the keyboard.
    await frames(1);
    act(() => {
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "p", metaKey: true, bubbles: true }));
      field.focus();
    });
    await frames();
    expect(document.activeElement).toBe(field);
    field.remove();
  });

  it("a focus request waits behind the palette, then lands", async () => {
    const a = useTiles.getState().addShellTile(ws.id, ws.cwd);
    setup();
    act(() => useUi.getState().setCenterMode(ws.id, "terminals"));
    const backdrop = document.createElement("div");
    backdrop.className = "palette-backdrop";
    const paletteInput = document.createElement("input");
    backdrop.appendChild(paletteInput);
    document.body.appendChild(backdrop);
    act(() => paletteInput.focus());
    act(() => focusTile(a.id));
    await frames();
    expect(document.activeElement).toBe(paletteInput);
    // The palette closes and gives focus back to a field: the request,
    // still waiting, lands anyway.
    const before = document.createElement("textarea");
    document.body.appendChild(before);
    act(() => {
      backdrop.remove();
      before.focus();
    });
    await frames();
    expect(document.activeElement).toBe(inputOf(a.id));
    before.remove();
  });

  it("closing a shell at its prompt asks nothing; one running a command asks", async () => {
    let running = false;
    const r = setup({ pty_shell_alone: () => !running, pty_kill: () => null });
    let t = tiles()[0];
    act(() => {
      t = useTiles.getState().addShellTile(ws.id, ws.cwd);
      useTiles.getState().setPtyId(t.id, "pty-1");
    });
    act(() => useUi.getState().setCenterMode(ws.id, "terminals"));
    running = true;
    await r.user.click(screen.getByRole("button", { name: "Close tile" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.getByText("Stop shell 1?")).toBeTruthy();
    await r.user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(tiles()[0].pendingClose).toBe(false);
    running = false;
    await r.user.click(screen.getByRole("button", { name: "Close tile" }));
    await act(async () => {});
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(tiles().length === 0 || tiles()[0].pendingClose).toBe(true);
  });

  // L2: ⌘⇧W on an idle shell closes it and hands over to the next tile at
  // once, keyboard included.
  it("⌘⇧W closes the current idle tile and the next one takes over", async () => {
    setup({ pty_shell_alone: () => true, pty_kill: () => null });
    let a = tiles()[0];
    let b = tiles()[0];
    act(() => {
      a = useTiles.getState().addShellTile(ws.id, ws.cwd);
      b = useTiles.getState().addShellTile(ws.id, ws.cwd);
      useTiles.getState().setPtyId(a.id, "pty-a");
      useTiles.getState().setPtyId(b.id, "pty-b");
      useUi.getState().setCenterMode(ws.id, "terminals");
    });
    act(() => inputOf(a.id).focus());
    expect(currentTileId(ws.id)).toBe(a.id);
    act(() => void requestCloseCurrentTile(ws.id));
    await waitFor(() => expect(lastFocusedTileForTests(ws.id)).toBe(b.id));
    expect(screen.queryByRole("dialog")).toBeNull();
    await frames();
    expect(document.activeElement).toBe(inputOf(b.id));
  });

  it("Close all asks once when a session is working", async () => {
    const r = setup({ pty_kill: () => null });
    act(() => {
      useTiles.getState().addClaudeTile(ws.id, ws.cwd);
      useTiles.getState().addClaudeTile(ws.id, ws.cwd);
    });
    act(() => useUi.getState().setCenterMode(ws.id, "terminals"));
    await r.user.click(screen.getByRole("button", { name: "More for Terminals" }));
    await r.user.click(screen.getByRole("menuitem", { name: "Close all (2)" }));
    expect(await screen.findByText("Close all 2 sessions?")).toBeTruthy();
    expect(screen.getByText(/2 of them are working/)).toBeTruthy();
    await r.user.click(screen.getByRole("button", { name: "Close all" }));
    await act(async () => {});
    expect(tiles().every((t) => t.pendingClose)).toBe(true);
  });
});
