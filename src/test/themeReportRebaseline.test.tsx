// 1.168.1 (C1, Challenger): a theme report makes Claude redraw. That redraw
// is a resize's, not the session working: a tile waiting on the member stays
// waiting (its silence clock is not restarted), as after a resize.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Terminal } from "../components/Terminal";
import { useTiles, type Tile } from "../store/tileStore";
import { BuilderSession } from "../components/BuilderSession";
import { useBuilder } from "../store/builderStore";
import { useSettings } from "../store/settingsStore";
import { setPlatformForTests } from "../lib/platform";
import { act, renderUi, waitFor } from "./render";

let screenRows: string[] = ["❯ "];
const made = vi.hoisted(() => [] as { options: Record<string, unknown> }[]);
// The program asked for reports (lib/themeReports is tested on a real xterm
// in themeReports.test.tsx): every flip sends one.
vi.mock("../lib/themeReports", async (load) => {
  const real = await load<typeof import("../lib/themeReports")>();
  return {
    ...real,
    trackThemeReports: (_t: unknown, dark: boolean, opts: { onReport?: () => void } = {}) => {
      let last = dark;
      return {
        enabled: true,
        notify(next: boolean) {
          if (next === last) return false;
          last = next;
          opts.onReport?.();
          return true;
        },
        dispose() {},
      };
    },
  };
});
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
    rows = 3;
    options: Record<string, unknown>;
    buffer = {
      active: {
        baseY: 0,
        length: 3,
        getLine: (i: number) => ({ translateToString: () => screenRows[i] ?? "" }),
      },
    };
    constructor(opts: Record<string, unknown> = {}) {
      this.options = { ...opts };
      made.push(this);
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

const bytes = (text: string) => Array.from(new TextEncoder().encode(text));
let clock = 1_000_000;
afterEach(() => {
  setPlatformForTests(null);
  vi.restoreAllMocks();
});

function tile(): Tile {
  return {
    id: "t1",
    workspaceId: "ws",
    kind: "claude",
    ptyId: "pty-1",
    label: "Claude",
    cwd: "/code",
    startedAt: clock - 60_000,
    status: "running",
    pendingClose: false,
    expanded: false,
  } as Tile;
}

const stamp = () => useTiles.getState().byWorkspace.ws?.tiles[0]?.lastOutputAt;
const setTheme = (theme: "light" | "dark") =>
  act(() =>
    useSettings.setState((s) => ({
      settings: { ...s.settings, appearance: { ...s.settings.appearance, theme } },
    })),
  );

describe("the redraw after a theme report", () => {
  it("does not restart a waiting tile's silence clock; later output does", async () => {
    setPlatformForTests("mac");
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    setTheme("light");
    act(() =>
      useTiles.setState({
        byWorkspace: { ws: { tiles: [tile()], expandedTileId: null, detailTileId: null } },
      }),
    );
    const view = renderUi(<Terminal cmd="claude" cli="claude" workspaceId="ws" readiness="claude" />, {
      fixtures: { pty_spawn: "pty-1", cli_fresh_check: null, pty_resize: null, pty_prompt_state: null, pty_prompt_idle: false },
    });
    view.tauri.allowUnhandled();
    await waitFor(() => expect(view.tauri.listeners("pty://data")).toBe(1));
    const emit = async (text: string) => {
      act(() => view.tauri.emit("pty://data", { id: "pty-1", data: bytes(text) }));
      await act(async () => new Promise((r) => setTimeout(r, 50)));
    };
    await emit("● ready");
    const quiet = clock;
    expect(stamp()).toBe(quiet);

    clock += 60_000; // waiting on the member a minute
    setTheme("dark");
    await emit("\x1b]11;?\x1b\\● ready (redrawn dark)");
    expect(stamp()).toBe(quiet);

    clock += 10_000; // past the redraw window: real output counts again
    await emit("✶ Working…");
    expect(stamp()).toBe(clock);
  });

  it("in the Builder too, and a Codex Builder gets the contrast floor", async () => {
    setPlatformForTests("mac");
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    setTheme("light");
    made.length = 0;
    useBuilder.setState({ byCard: {} });
    const view = renderUi(<BuilderSession workspaceId="ws" cardId="c1" ptyId="pty-1" vendor="codex" />, {
      fixtures: { builder_read_capture: new Uint8Array(8).buffer, pty_resize: null },
    });
    view.tauri.allowUnhandled();
    await waitFor(() => expect(view.tauri.listeners("pty://data")).toBe(1));
    await waitFor(() => expect(view.tauri.callsOf("builder_read_capture")).toHaveLength(1));
    expect(made[0].options.minimumContrastRatio).toBe(3);
    const emit = async (text: string, offset: number) => {
      act(() => view.tauri.emit("pty://data", { id: "pty-1", data: bytes(text), offset }));
      await act(async () => new Promise((r) => setTimeout(r, 50)));
    };
    await emit("• ready", 0);
    const quiet = useBuilder.getState().byCard.c1?.lastOutputAt;
    expect(quiet).toBe(clock);
    clock += 60_000;
    setTheme("dark");
    await emit("• ready (redrawn)", 7);
    expect(useBuilder.getState().byCard.c1?.lastOutputAt).toBe(quiet);
  });
});
