// 1.172.0 B3 (walk 2026-10-27): a Claude tile said "Starting…" for over 30 s
// with its prompt already drawn, and "Your turn" only after a keystroke.
// "Starting…" ends by time alone (STARTING_MS) and the header's 1 Hz tick
// stops while the page reads as hidden (a window behind others, as the test
// bridge drives it): nothing redrew the header when Starting ended. The tile
// now redraws once at that moment, so it says what its scans found.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TileGrid } from "../components/TileGrid";
import { useTiles, type Tile } from "../store/tileStore";
import { useWorkspaces, type Workspace } from "../store/workspaceStore";
import type { ShellEnvInfo } from "../ipc";
import { STARTING, STARTING_MS, tileStatusLine } from "../lib/tileStatusLine";
import { FRESH_SCAN_MEMORY, foldScan, nextReadiness, readinessProbe, type Readiness, type ScanMemory } from "../lib/tileHeaderStatus";
import { act, renderUi } from "./render";

vi.mock("../components/Terminal", () => ({ Terminal: () => <div data-testid="terminal" /> }));
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
  claudeVersion: "2.1.311",
  codexPath: "/usr/local/bin/codex",
  codexVersion: "0.163.0",
  codexHealthy: true,
  gitPath: "/usr/bin/git",
  gitVersion: "2.50.1",
  ghPath: null,
  ghVersion: null,
  supportsStreamJson: true,
  probeError: null,
};

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event("visibilitychange"));
}

const statusText = () => document.querySelector(".tile-status")?.textContent ?? "";

function seed(over: (t: Tile) => Partial<Tile>) {
  act(() => {
    useWorkspaces.setState({ workspaces: [ws], activeId: ws.id });
    const t = useTiles.getState().addClaudeTile(ws.id, ws.cwd);
    const tile: Tile = { ...t, ptyId: "pty-1", status: "running", startedAt: Date.now(), ...over(t) };
    useTiles.setState((s) => ({
      byWorkspace: { ...s.byWorkspace, [ws.id]: { ...s.byWorkspace[ws.id], tiles: [tile] } },
    }));
  });
}

describe("a Claude tile's Starting… with the page hidden", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    useTiles.setState({ byWorkspace: {} } as never);
  });
  afterEach(() => {
    setHidden(false);
    vi.useRealTimers();
  });

  it("says Your turn once Starting ends, its prompt read Ready with nothing redrawing it", async () => {
    // No output stamped yet (Starting by rule), the scans long since Ready.
    seed(() => ({
      lastOutputAt: undefined,
      readiness: { lastOutputAt: Date.now() - 10_000, matcherIdle: true, leftReadyAt: Date.now() - 10_000 },
    }));
    const r = renderUi(<TileGrid env={env} workspace={ws} />);
    r.tauri.allowUnhandled();
    act(() => setHidden(true));
    expect(statusText()).toBe(STARTING);
    await act(async () => {
      vi.advanceTimersByTime(STARTING_MS + 100);
    });
    expect(statusText()).not.toBe(STARTING);
    expect(statusText()).toBe("Your turn");
  });

  it("says it is working once Starting ends, its scans saying it works", async () => {
    seed((t) => ({
      lastOutputAt: Date.now(),
      readiness: { lastOutputAt: Date.now(), matcherIdle: false, leftReadyAt: t.startedAt },
    }));
    const r = renderUi(<TileGrid env={env} workspace={ws} />);
    r.tauri.allowUnhandled();
    act(() => setHidden(true));
    expect(statusText()).toBe(STARTING);
    await act(async () => {
      vi.advanceTimersByTime(STARTING_MS + 100);
    });
    expect(statusText()).toMatch(/^Working · /);
  });
});

// The scans themselves: a fresh Claude screen (its welcome, the empty box,
// no turn yet) reads Ready about two seconds after it is drawn — the
// detection was right; only the redraw was missing.
describe("a fresh Claude screen", () => {
  it("reads Your turn two seconds after its prompt is drawn", () => {
    const T0 = 1_700_000_000_000;
    const FRESH = [
      "╭─── Claude Code v2.1.311 ──────────────────────────╮",
      "│            Welcome back!                          │",
      "│   ▐▛███▜▌   Opus 5.5 · Claude Max                 │",
      "╰───────────────────────────────────────────────────╯",
      "",
      "────────────────────────────────────────────────────",
      '❯ Try "refactor <filepath>"',
      "────────────────────────────────────────────────────",
      "  ? for shortcuts",
    ];
    let memory: ScanMemory = { ...FRESH_SCAN_MEMORY, activityAt: T0 };
    let readiness: Readiness = { lastOutputAt: T0, matcherIdle: false, leftReadyAt: T0 };
    const scan = (at: number, screen: string[], sawData: boolean) => {
      const p = readinessProbe("claude", screen);
      memory = foldScan(memory, {
        idle: p.idle, status: p.status, signature: p.signature, sawData, dataAt: at, rebaselining: false, now: at, screen: true, running: p.running,
      });
      readiness = nextReadiness("claude", readiness, { lastOutputAt: memory.activityAt, matcherIdle: memory.lastVerdict ?? null }, at);
    };
    const line = (at: number) =>
      tileStatusLine({ kind: "claude", status: "running", startedAt: T0, readiness, lastOutputAt: T0 + 300, now: at }).text;
    scan(T0 + 300, [""], true);
    scan(T0 + 1_200, FRESH, true);
    expect(line(T0 + 1_500)).toBe(STARTING);
    scan(T0 + 2_000, FRESH, false);
    expect(line(T0 + 3_300)).toBe("Your turn");
  });
});
