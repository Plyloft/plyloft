// 1.176.0 R7: a Claude or Codex tile whose CLI didn't start says so under its
// header, with Repair beside the header's Restart — and only then: a session
// the person ended, one that drew its screen, a slow exit or a shell tile
// keep the neutral ended state. The tile listens before its spawn, so even an
// exit emitted before `pty_spawn` returned reaches it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Tile as TileView } from "../components/Tile";
import { useTiles, type Tile } from "../store/tileStore";
import { Terminal } from "../components/Terminal";
import { markPtyClosing } from "../lib/ptyGone";
import { act, renderUi, screen, waitFor } from "./render";

const openRepair = vi.fn(async (_tool: string) => {});
vi.mock("../lib/openRepair", () => ({ openRepair: (tool: string) => openRepair(tool) }));

const written: string[] = [];
const typeHandlers: Array<(data: string) => void> = [];
vi.mock("@xterm/xterm", () => {
  const deep = (): unknown =>
    new Proxy(function () {}, {
      get: (_t, prop) => (prop === "dispose" ? () => {} : deep()),
      apply: () => deep(),
    });
  class FakeTerm {
    cols = 100;
    rows = 10;
    options: Record<string, unknown> = {};
    modes = { bracketedPasteMode: false };
    buffer = { active: { baseY: 0, type: "normal", length: 0, getLine: () => ({ translateToString: () => "" }) } };
    constructor() {
      return new Proxy(this, {
        get(target, prop, receiver) {
          if (prop in target) return Reflect.get(target, prop, receiver);
          if (prop === "then") return undefined;
          return deep();
        },
      });
    }
    write(data: string | Uint8Array, done?: () => void) {
      written.push(typeof data === "string" ? data : new TextDecoder().decode(data));
      done?.();
    }
    writeln(data: string) {
      written.push(`${data}\n`);
    }
    onData(cb: (data: string) => void) {
      typeHandlers.push(cb);
      return { dispose() {} };
    }
  }
  return { Terminal: FakeTerm };
});
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} dispose() {} proposeDimensions() { return undefined; } } }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class { dispose() {} onContextLoss() { return { dispose() {} }; } } }));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: class { dispose() {} } }));
vi.mock("@xterm/addon-image", () => ({ ImageAddon: class { dispose() {} } }));

const bytes = (text: string) => Array.from(new TextEncoder().encode(text));

afterEach(() => {
  act(() => useTiles.setState({ byWorkspace: {} }));
  written.length = 0;
  typeHandlers.length = 0;
  openRepair.mockClear();
  vi.restoreAllMocks();
});

function tile(kind: Tile["kind"]): Tile {
  return {
    id: "t1",
    workspaceId: "ws",
    kind,
    ptyId: null,
    label: kind,
    cwd: "/code",
    startedAt: Date.now(),
    status: "running",
    pendingClose: false,
    expanded: false,
  } as Tile;
}

function Live() {
  const t = useTiles((s) => s.byWorkspace.ws?.tiles[0]);
  return t ? <TileView tile={t} env={null} workspaceCwd="/code" hidden={false} /> : null;
}

const now = () => useTiles.getState().byWorkspace.ws.tiles[0];

/** A tile of `kind` whose spawn is answered by `spawn` (given the emit). */
function mount(kind: Tile["kind"], spawn: (id: string, emit: (event: string, payload: unknown) => void) => unknown, more: Record<string, unknown> = {}) {
  act(() => useTiles.setState({ byWorkspace: { ws: { tiles: [tile(kind)], expandedTileId: null, detailTileId: null } } }));
  let emit: (event: string, payload: unknown) => void = () => {};
  const view = renderUi(<Live />, {
    fixtures: {
      cli_fresh_check: null,
      pty_resize: null,
      pty_prompt_state: null,
      pty_prompt_idle: false,
      pty_write: null,
      pty_kill: null,
      tile_screen_block: null,
      // R7: the backend's answer for a quick exit — a certain failure here.
      cli_start_verdict: "fails",
      pty_spawn: (args: Record<string, unknown>) => spawn(String(args.id), (e, p) => emit(e, p)),
      ...more,
    },
  });
  emit = (e, p) => view.tauri.emit(e, p);
  view.tauri.allowUnhandled();
  return view;
}

describe("a Claude or Codex tile whose CLI didn't start", () => {
  it("hears an exit emitted before its spawn returned, keeps the output, and offers Repair once the backend confirms", async () => {
    const view = mount("claude", (id, emit) => {
      // The CLI prints and dies while the spawn is still returning.
      emit("pty://data", { id, data: bytes("Error: Cannot find module 'cli.js'\r\n") });
      emit("pty://exit", { id, code: 1 });
      return id;
    });
    const spawned = () => view.tauri.callsOf("pty_spawn")[0]?.args;
    await waitFor(() => expect(now().status).toBe("crashed"));
    // A lowercase UUID the tile listened under before the call.
    expect(String(spawned()!.id)).toMatch(/^[0-9a-f-]{36}$/);
    expect(written.join("")).toContain("Cannot find module");
    expect(written.join("")).toContain("[process exited (code 1)]");
    await waitFor(() => expect(now().startFailed).toEqual({ tool: "claude", cause: "stoppedAtOnce" }));
    expect(view.tauri.callsOf("cli_start_verdict").map((c) => c.args)).toEqual([{ tool: "claude" }]);
    // The header says it too.
    expect(screen.getByText("Didn't start")).toBeTruthy();
    expect(screen.getByRole("status", { name: "" }).textContent).toContain(
      "Claude Code didn't start: it stopped as soon as it started, and it doesn't answer Plyloft's check.",
    );
    await view.user.click(screen.getByRole("button", { name: "Repair Claude Code" }));
    expect(openRepair).toHaveBeenCalledWith("claude");
    // The header's own Restart is still there.
    expect(screen.getByRole("button", { name: "Restart" })).toBeTruthy();
  });

  it("says nothing more for a CLI that drew its screen first", async () => {
    mount("codex", (id, emit) => {
      emit("pty://data", { id, data: bytes("\x1b[?2004h\x1b[?1004h\x1b[?1049h sign in") });
      emit("pty://exit", { id, code: 1 });
      return id;
    });
    await waitFor(() => expect(now().status).toBe("crashed"));
    expect(now().startFailed).toBeUndefined();
    expect(screen.queryByRole("button", { name: "Repair Codex" })).toBeNull();
  });

  it("says nothing more for a clean quit or Ctrl-C", async () => {
    mount("claude", (id, emit) => {
      emit("pty://exit", { id, code: 0 });
      return id;
    });
    await waitFor(() => expect(now().status).toBe("done"));
    expect(now().startFailed).toBeUndefined();
  });

  it("says nothing more once the person typed", async () => {
    let ptyId = "";
    const view = mount("claude", (id) => {
      ptyId = id;
      return id;
    });
    await waitFor(() => expect(typeHandlers.length).toBe(1));
    act(() => typeHandlers[0]("x"));
    act(() => view.tauri.emit("pty://exit", { id: ptyId, code: 1 }));
    await waitFor(() => expect(now().status).toBe("crashed"));
    expect(now().startFailed).toBeUndefined();
  });

  it("says nothing more for an exit after the first seconds", async () => {
    let clock = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    let ptyId = "";
    const view = mount("codex", (id) => {
      ptyId = id;
      return id;
    });
    await waitFor(() => expect(view.tauri.callsOf("pty_spawn").length).toBe(1));
    await waitFor(() => expect(typeHandlers.length).toBe(1));
    clock += 6_000;
    act(() => view.tauri.emit("pty://exit", { id: ptyId, code: 1 }));
    await waitFor(() => expect(now().status).toBe("crashed"));
    expect(now().startFailed).toBeUndefined();
  });

  it("never for a shell tile", async () => {
    mount("shell", (id, emit) => {
      emit("pty://exit", { id, code: 127 });
      return id;
    });
    await waitFor(() => expect(now().status).toBe("crashed"));
    expect(now().startFailed).toBeUndefined();
    expect(screen.queryByRole("button", { name: /^Repair/ })).toBeNull();
  });

  it("offers Repair when the CLI isn't there even after looking again, and says so in the terminal too", async () => {
    const view = mount("codex", (id) => id, {
      cli_fresh_check: () => {
        throw 'PLY_CLI_UNAVAILABLE_V1:{"tool":"codex","was":"/opt/homebrew/bin/codex"}\ncodex: not found in PATH; it was at /opt/homebrew/bin/codex.';
      },
    });
    await waitFor(() => expect(now().status).toBe("crashed"));
    expect(view.tauri.callsOf("pty_spawn")).toEqual([]);
    expect(now().startFailed).toEqual({ tool: "codex", cause: "gone" });
    expect(written.join("")).toContain("Press Repair Codex above, or Restart.");
    expect(written.join("")).not.toContain("Setup checks");
    await view.user.click(screen.getByRole("button", { name: "Repair Codex" }));
    expect(openRepair).toHaveBeenCalledWith("codex");
  });

  it("a shell that didn't spawn points to Diagnostics in words, with no Repair", async () => {
    mount("shell", () => {
      throw "spawn: No such file or directory (os error 2)";
    });
    await waitFor(() => expect(now().status).toBe("crashed"));
    expect(written.join("")).toContain("Settings › Setup and account › Diagnostics checks the shell.");
    expect(now().startFailed).toBeUndefined();
  });

  it("a CLI that ran and refused (the backend says it starts) keeps the neutral end", async () => {
    const view = mount(
      "claude",
      (id, emit) => {
        emit("pty://data", { id, data: bytes("error: unknown option '--frobnicate'\r\n") });
        emit("pty://exit", { id, code: 1 });
        return id;
      },
      { cli_start_verdict: "starts" },
    );
    await waitFor(() => expect(view.tauri.callsOf("cli_start_verdict").length).toBe(1));
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(now().status).toBe("crashed");
    expect(now().startFailed).toBeUndefined();
    expect(screen.queryByRole("button", { name: "Repair Claude Code" })).toBeNull();
    expect(screen.queryByText("Didn't start")).toBeNull();
  });

  it("the backend can't tell (slow, mid-update): neutral", async () => {
    const view = mount(
      "codex",
      (id, emit) => {
        emit("pty://exit", { id, code: 1 });
        return id;
      },
      { cli_start_verdict: "unknown" },
    );
    await waitFor(() => expect(view.tauri.callsOf("cli_start_verdict").length).toBe(1));
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(now().startFailed).toBeUndefined();
  });

  it("Plyloft's own kill never reads as a start failure, and asks nothing", async () => {
    let ptyId = "";
    const view = mount("claude", (id) => {
      ptyId = id;
      return id;
    });
    await waitFor(() => expect(typeHandlers.length).toBe(1));
    markPtyClosing(ptyId);
    act(() => view.tauri.emit("pty://exit", { id: ptyId, code: 1 }));
    await waitFor(() => expect(now().status).toBe("crashed"));
    expect(view.tauri.callsOf("cli_start_verdict")).toEqual([]);
    expect(now().startFailed).toBeUndefined();
  });

  it("a restart starts a tile without the line", async () => {
    mount("claude", (id, emit) => {
      emit("pty://exit", { id, code: 1 });
      return id;
    });
    await waitFor(() => expect(now().startFailed).toBeTruthy());
    act(() => {
      useTiles.getState().restartTile("t1", "fresh");
    });
    expect(now().startFailed).toBeUndefined();
  });
});

describe("the tile's own PTY id", () => {
  it("two tiles spawning at once each keep to their own id", async () => {
    const view = renderUi(
      <>
        <Terminal cmd="sh" readiness="shell" />
        <Terminal cmd="sh" readiness="shell" />
      </>,
      {
        fixtures: {
          pty_resize: null,
          pty_prompt_state: null,
          pty_write: null,
          pty_kill: null,
          // Each spawn prints under its own id while the other is starting.
          pty_spawn: (args: Record<string, unknown>) => {
            const id = String(args.id);
            view.tauri.emit("pty://data", { id, data: bytes(`hello from ${id}\r\n`) });
            return id;
          },
        },
      },
    );
    view.tauri.allowUnhandled();
    await waitFor(() => expect(view.tauri.callsOf("pty_spawn").length).toBe(2));
    const ids = view.tauri.callsOf("pty_spawn").map((c) => String(c.args.id));
    expect(new Set(ids).size).toBe(2);
    await waitFor(() => expect(written.filter((w) => w.startsWith("hello from ")).length).toBe(2));
    // Each line once: no tile wrote the other's.
    for (const id of ids) expect(written.filter((w) => w.includes(id)).length).toBe(1);
  });

  it("a tile unmounted during its spawn kills the PTY once and keeps nothing", async () => {
    let release: (id: string) => void = () => {};
    const view = renderUi(<Terminal cmd="sh" readiness="shell" />, {
      fixtures: {
        pty_resize: null,
        pty_prompt_state: null,
        pty_write: null,
        pty_kill: null,
        pty_spawn: (args: Record<string, unknown>) => new Promise<string>((r) => (release = () => r(String(args.id)))),
      },
    });
    view.tauri.allowUnhandled();
    await waitFor(() => expect(view.tauri.callsOf("pty_spawn").length).toBe(1));
    const id = String(view.tauri.callsOf("pty_spawn")[0].args.id);
    view.unmount();
    await act(async () => {
      release(id);
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(view.tauri.callsOf("pty_kill").map((c) => c.args.id)).toEqual([id]);
    expect(view.tauri.listeners("pty://data")).toBe(0);
    expect(view.tauri.listeners("pty://exit")).toBe(0);
  });
});
