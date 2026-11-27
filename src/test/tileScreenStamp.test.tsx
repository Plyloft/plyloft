// Windows (tiles' parity with the Builder, group B walk): a Claude tile idle
// at its prompt in a ConPTY prints bytes on every focus change, mouse report
// and resize (fixtures/claudeConptyIdle.json). There, the tile's output stamp
// — what its silence, dot and the Inbox "waiting for your answer" row go by —
// moves only when the screen changed. The Mac still stamps on arrival.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Terminal } from "../components/Terminal";
import { useTiles, type Tile } from "../store/tileStore";
import { setPlatformForTests } from "../lib/platform";
import { act, renderUi, waitFor } from "./render";

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
    rows = 3;
    options: Record<string, unknown> = {};
    buffer = {
      active: {
        baseY: 0,
        length: 3,
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

const bytes = (text: string) => Array.from(new TextEncoder().encode(text));
const MODES = "\x1b[?2004h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h";

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

async function mounted() {
  screenRows = ["❯ "];
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
  return view;
}

async function emit(view: Awaited<ReturnType<typeof mounted>>, text: string) {
  act(() => view.tauri.emit("pty://data", { id: "pty-1", data: bytes(text) }));
  await act(async () => new Promise((r) => setTimeout(r, 50)));
}

const stamp = () => useTiles.getState().byWorkspace.ws?.tiles[0]?.lastOutputAt;

describe("a Claude tile's output stamp", () => {
  it("on Windows, ignores bytes that leave the screen as it was", async () => {
    setPlatformForTests("windows");
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const view = await mounted();
    screenRows = ["● ready", "❯ "];
    await emit(view, "● ready");
    expect(stamp()).toBe(clock);
    const first = clock;
    clock += 5_000;
    await emit(view, MODES); // its answer to a focus report: the same screen
    expect(stamp()).toBe(first);
    clock += 5_000;
    screenRows = ["● ready", "✶ Working…", "❯ "];
    await emit(view, "✶ Working…");
    expect(stamp()).toBe(clock);
  });

  it("on the Mac, stamps every arrival as before", async () => {
    setPlatformForTests("mac");
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const view = await mounted();
    await emit(view, "● ready");
    clock += 5_000;
    await emit(view, MODES);
    expect(stamp()).toBe(clock);
  });
});
