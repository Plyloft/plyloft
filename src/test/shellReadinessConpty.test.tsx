// Owner decision (2026-10-19): a shell tile says Running / Ready. On Windows
// a PowerShell prompt under ConPTY has no line-editor probe and no command
// blocks, so output quiet decides — and Terminal notes a shell's output once
// xterm has drawn it, only when the screen changed (`screenChange.ts`).
//
// Challenger: what that rule must still count, through the real component —
// - a command printing the same line again and again: the screen reads the
//   same frame to frame, but the buffer scrolled, so it is output (Running);
// - a console command the tile's Job Object holds (`ping -t`, `git fetch`)
//   that prints nothing new: the PTY says running, whatever the screen;
// while a ConPTY repaint (same screen, no scroll) stays no output (Ready).
// The Mac notes every arrival, as before.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Terminal } from "../components/Terminal";
import { useTiles, type Tile } from "../store/tileStore";
import { setPlatformForTests } from "../lib/platform";
import { tileStatusLine } from "../lib/tileStatusLine";
import { act, renderUi, waitFor } from "./render";

let screenRows: string[] = [""];
const scrollListeners = new Set<() => void>();
/** A batch carrying this scrolls the fake buffer by one line. */
const SCROLLS = "\n";
vi.mock("@xterm/xterm", () => {
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
        type: "normal",
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
    onScroll(listener: () => void) {
      scrollListeners.add(listener);
      return { dispose: () => scrollListeners.delete(listener) };
    }
    write(data: string | Uint8Array, done?: () => void) {
      const text = typeof data === "string" ? data : new TextDecoder().decode(data);
      if (text.includes(SCROLLS)) for (const l of scrollListeners) l();
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
/** ConPTY's repaint of a same-size resize: home, the same rows, no scroll. */
const REPAINT = "\x1b[?25l\x1b[H\x1b[KPS C:\\Users\\me> \x1b[K\x1b[?25h";

let clock = 1_000_000;
let promptState: "running" | null = null;
afterEach(() => {
  setPlatformForTests(null);
  vi.restoreAllMocks();
  scrollListeners.clear();
});

function tile(): Tile {
  return {
    id: "t1",
    workspaceId: "ws",
    kind: "shell",
    ptyId: "pty-1",
    label: "pwsh",
    cwd: "C:\\code",
    startedAt: clock - 60_000,
    status: "running",
    pendingClose: false,
    expanded: false,
  } as Tile;
}

async function mounted() {
  screenRows = ["PS C:\\Users\\me> "];
  promptState = null;
  act(() =>
    useTiles.setState({
      byWorkspace: { ws: { tiles: [tile()], expandedTileId: null, detailTileId: null } },
    }),
  );
  const view = renderUi(<Terminal cmd="pwsh" workspaceId="ws" readiness="shell" />, {
    fixtures: { pty_spawn: "pty-1", pty_resize: null, pty_prompt_state: () => promptState },
  });
  view.tauri.allowUnhandled();
  await waitFor(() => expect(view.tauri.listeners("pty://data")).toBe(1));
  return view;
}

const readiness = () => useTiles.getState().byWorkspace.ws?.tiles[0]?.readiness;
const scans = (view: Awaited<ReturnType<typeof mounted>>) =>
  view.tauri.callsOf("pty_prompt_state").length;

/** Emit one PTY batch and wait for the readiness scan that follows it. */
async function emit(view: Awaited<ReturnType<typeof mounted>>, text: string) {
  const before = scans(view);
  act(() => view.tauri.emit("pty://data", { id: "pty-1", data: bytes(text) }));
  await waitFor(() => expect(scans(view)).toBeGreaterThan(before), { timeout: 2000 });
  await act(async () => new Promise((r) => setTimeout(r, 20)));
}

const words = () =>
  tileStatusLine({ kind: "shell", status: "running", startedAt: clock - 60_000, readiness: readiness(), now: clock }).text;

describe("a Windows shell tile's readiness, through the component", () => {
  it("a repaint stays Ready; the same line printed again and again is Running", async () => {
    setPlatformForTests("windows");
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const view = await mounted();
    await emit(view, "PS C:\\Users\\me> ");
    const first = clock;
    clock += 5_000;
    expect(words()).toBe("Ready");

    // A ConPTY repaint: bytes, the same screen, no scroll — not output.
    await emit(view, REPAINT);
    expect(readiness()?.lastOutputAt).toBe(first);
    expect(words()).toBe("Ready");

    // `while (1) { "tick"; sleep 1 }` with the screen full of "tick": each
    // frame reads as the last, but the buffer scrolled — output.
    screenRows = ["tick", "tick", "tick"];
    await emit(view, "tick\r\n");
    clock += 5_000;
    await emit(view, "tick\r\n");
    expect(readiness()?.lastOutputAt).toBe(clock);
    expect(words()).toBe("Running");
  });

  it("a command the tile's job holds is Running though nothing new is drawn", async () => {
    setPlatformForTests("windows");
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const view = await mounted();
    await emit(view, "PS C:\\Users\\me> ");
    clock += 5_000;
    expect(words()).toBe("Ready");
    // `ping -n 30 host > $null`: a console process in the job, no output.
    promptState = "running";
    await emit(view, REPAINT);
    expect(readiness()?.matcherIdle).toBe(false);
    clock += 30_000;
    expect(words()).toBe("Running");
  });

  // Windows walk (2026-10-20): Single → Split re-wrapped a long command line
  // already on screen; ConPTY's repaint changed the drawn screen and the idle
  // prompt read Running for ~2 s. The app's own refit is no command.
  it("a layout change that re-wraps the screen stays Ready; output after it is Running", async () => {
    setPlatformForTests("windows");
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const observers: ResizeObserverCallback[] = [];
    vi.spyOn(window, "ResizeObserver").mockImplementation(function (this: unknown, cb: ResizeObserverCallback) {
      observers.push(cb);
      return { observe() {}, unobserve() {}, disconnect() {} } as unknown as ResizeObserver;
    } as unknown as typeof ResizeObserver);
    const view = await mounted();
    screenRows = ["PS C:\\Users\\me> git log --oneline --graph --decorate --all -", "-max-count 20", "PS C:\\Users\\me> "];
    await emit(view, "PS C:\\Users\\me> ");
    const first = clock;
    clock += 5_000;
    expect(words()).toBe("Ready");
    await waitFor(() => expect(observers.length).toBeGreaterThan(0));

    // Split: the pane narrows, xterm re-wraps, ConPTY repaints it.
    act(() => observers.forEach((cb) => cb([], {} as ResizeObserver)));
    clock += 100;
    screenRows = ["PS C:\\Users\\me> git log --oneline", " --graph --decorate --all", " --max-count 20", "PS C:\\Users\\me> "];
    await emit(view, REPAINT);
    expect(readiness()?.lastOutputAt).toBe(first);
    clock += 1_000;
    expect(words()).toBe("Ready");
    // Single again: the same.
    act(() => observers.forEach((cb) => cb([], {} as ResizeObserver)));
    screenRows = ["PS C:\\Users\\me> git log --oneline --graph --decorate --all -", "-max-count 20", "PS C:\\Users\\me> "];
    await emit(view, REPAINT);
    expect(readiness()?.lastOutputAt).toBe(first);
    expect(words()).toBe("Ready");

    // Past the window, real output on screen: Running.
    clock += 2_000;
    screenRows = ["PS C:\\Users\\me> dir", "    Directory: C:\\Users\\me", ""];
    await emit(view, "dir\r\n    Directory: C:\\Users\\me\r\n");
    expect(readiness()?.lastOutputAt).toBe(clock);
    expect(words()).toBe("Running");
  });

  it("on the Mac, every arrival is noted as before", async () => {
    setPlatformForTests("mac");
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const view = await mounted();
    await emit(view, "% ");
    clock += 5_000;
    await emit(view, REPAINT);
    expect(readiness()?.lastOutputAt).toBe(clock);
  });
});
