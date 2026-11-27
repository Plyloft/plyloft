// 1.168.1 (#6, Windows; fallback B): ConPTY drops Claude's background
// question, so a Claude session can't follow a light/dark switch live on
// Windows. Its tile (or the Builder on the card page) then says so, with
// Restart — the tile resumes the same conversation. The light/dark the
// session started in is the backend's (recorded at spawn). Never on the Mac,
// never for Codex or a session Plyloft gave no theme; back to the session's
// own theme, the line goes. A Restart that would stop work asks first.
import { afterEach, describe, expect, it } from "vitest";
import { ThemeRestartLine } from "../components/ThemeRestartLine";
import {
  offersThemeRestart,
  resetThemeRestartForTests,
  RESTART_WHILE_WORKING,
  THEME_REOPEN_WORDS,
  THEME_RESTART_WORDS,
} from "../lib/themeRestart";
import { setPlatformForTests } from "../lib/platform";
import { useSettings } from "../store/settingsStore";
import { useTiles, type Tile } from "../store/tileStore";
import { useBuilder } from "../store/builderStore";
import { restartForTheme, restartRunningSession } from "../store/tileRestart";
import { restartBuilderSession } from "../components/BuilderRunStep";
import { act, renderUi, screen, waitFor } from "./render";
import { tauri } from "./tauri";

afterEach(() => {
  setPlatformForTests(null);
  resetThemeRestartForTests();
});

const setTheme = (theme: "light" | "dark") =>
  act(() =>
    useSettings.setState((s) => ({
      settings: { ...s.settings, appearance: { ...s.settings.appearance, theme } },
    })),
  );

describe("offersThemeRestart", () => {
  const base = { windows: true, consoleHost: "system" as const, vendor: "claude", startedDark: false, nowDark: true, dismissedFor: null };
  it("only on Windows, only for Claude, only after a flip from a known start, until dismissed for it", () => {
    expect(offersThemeRestart(base)).toBe(true);
    expect(offersThemeRestart({ ...base, windows: false })).toBe(false);
    expect(offersThemeRestart({ ...base, vendor: "codex" })).toBe(false);
    expect(offersThemeRestart({ ...base, startedDark: null })).toBe(false);
    expect(offersThemeRestart({ ...base, nowDark: false })).toBe(false);
    expect(offersThemeRestart({ ...base, dismissedFor: true })).toBe(false);
    expect(offersThemeRestart({ ...base, dismissedFor: false })).toBe(true);
  });

  // 1.169.0 (B2): on Plyloft's own ConPTY, OSC 11 gets through and Claude
  // follows the switch live — the line is only for the system ConPTY.
  it("only on the system ConPTY: never on the bundled one, nor before the backend says", () => {
    expect(offersThemeRestart({ ...base, consoleHost: "bundled" })).toBe(false);
    expect(offersThemeRestart({ ...base, consoleHost: null })).toBe(false);
    expect(offersThemeRestart({ ...base, consoleHost: "system" })).toBe(true);
  });
});

describe("the line on a Claude session", () => {
  it("compares with the light/dark the session started in, from the backend", async () => {
    setPlatformForTests("windows");
    // The app is Dark now, but the session started Light (spawned before).
    setTheme("dark");
    let restarts = 0;
    const view = renderUi(
      <ThemeRestartLine ptyId="pty-1" vendor="claude" onRestart={async () => void (restarts += 1)} />,
      { fixtures: { pty_session_lightness: "light", pty_console_host: "system" } },
    );
    expect(await screen.findByText(THEME_RESTART_WORDS)).toBeTruthy();
    expect(view.tauri.callsOf("pty_session_lightness")[0].args).toEqual({ id: "pty-1" });
    await view.user.click(screen.getByRole("button", { name: "Restart" }));
    expect(restarts).toBe(1);
    setTheme("light");
    expect(screen.queryByText(THEME_RESTART_WORDS)).toBeNull();
    setTheme("dark");
    await view.user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(THEME_RESTART_WORDS)).toBeNull();
    // Leaving and coming back (the card page): still dismissed.
    view.unmount();
    renderUi(<ThemeRestartLine ptyId="pty-1" vendor="claude" onRestart={async () => {}} />, {
      fixtures: { pty_session_lightness: "light", pty_console_host: "system" },
    });
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(screen.queryByText(THEME_RESTART_WORDS)).toBeNull();
    // Over and back again: it asks again.
    setTheme("light");
    setTheme("dark");
    expect(screen.getByText(THEME_RESTART_WORDS)).toBeTruthy();
  });

  it("without a Restart says how instead; a session Plyloft didn't theme says nothing", async () => {
    setPlatformForTests("windows");
    setTheme("dark");
    const a = renderUi(<ThemeRestartLine ptyId="pty-2" vendor="claude" />, { fixtures: { pty_session_lightness: "light", pty_console_host: "system" } });
    expect(await screen.findByText(THEME_REOPEN_WORDS)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Restart" })).toBeNull();
    a.unmount();
    renderUi(<ThemeRestartLine ptyId="pty-3" vendor="claude" onRestart={async () => {}} />, {
      fixtures: { pty_session_lightness: null, pty_console_host: "system" },
    });
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(screen.queryByText(THEME_RESTART_WORDS)).toBeNull();
  });

  it("a session on the bundled ConPTY gets no line: Claude follows the switch itself", async () => {
    setPlatformForTests("windows");
    setTheme("dark");
    const view = renderUi(<ThemeRestartLine ptyId="pty-6" vendor="claude" onRestart={async () => {}} />, {
      fixtures: { pty_session_lightness: "light", pty_console_host: "bundled" },
    });
    await waitFor(() => expect(view.tauri.callsOf("pty_console_host")).toHaveLength(1));
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(screen.queryByText(THEME_RESTART_WORDS)).toBeNull();
  });

  it("never on the Mac, never for Codex — and doesn't ask the backend there", async () => {
    setPlatformForTests("mac");
    setTheme("dark");
    const mac = renderUi(<ThemeRestartLine ptyId="pty-4" vendor="claude" onRestart={async () => {}} />);
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(screen.queryByText(THEME_RESTART_WORDS)).toBeNull();
    expect(mac.tauri.callsOf("pty_session_lightness")).toHaveLength(0);
    expect(mac.tauri.callsOf("pty_console_host")).toHaveLength(0);
    mac.unmount();
    setPlatformForTests("windows");
    const codex = renderUi(<ThemeRestartLine ptyId="pty-5" vendor="codex" onRestart={async () => {}} />);
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(screen.queryByText(THEME_RESTART_WORDS)).toBeNull();
    expect(codex.tauri.callsOf("pty_session_lightness")).toHaveLength(0);
  });
});

function claudeTile(over: Partial<Tile> = {}): Tile {
  return {
    id: "t1",
    workspaceId: "ws",
    kind: "claude",
    ptyId: "pty-1",
    label: "Claude",
    cwd: "/code/app",
    startedAt: 1,
    status: "running",
    pendingClose: false,
    expanded: false,
    cliSessionId: "sid-1",
    ...over,
  } as Tile;
}

const IDLE = { matcherIdle: true, waiting: false, background: false, running: false, lastOutputAt: 0 };

describe("Restart on a running Claude tile", () => {
  it("stops the session, then continues the same conversation", async () => {
    const tile = claudeTile();
    act(() => useTiles.setState({ byWorkspace: { ws: { tiles: [tile], expandedTileId: null, detailTileId: null } } }));
    const stub = tauri();
    stub.fixture("pty_kill", () => {
      // The PTY's exit, as Terminal reports it.
      setTimeout(() => useTiles.getState().markExited("t1", 0), 10);
      return null;
    });
    stub.fixture("terminal_resume_check", { kind: "ready" });
    const id = await restartRunningSession(tile);
    expect(stub.callsOf("pty_kill")[0].args).toEqual({ id: "pty-1" });
    expect(stub.callsOf("terminal_resume_check")[0].args).toMatchObject({ kind: "claude", cliSessionId: "sid-1" });
    const fresh = useTiles.getState().byWorkspace.ws.tiles.find((t) => t.id === id);
    expect(fresh?.args).toEqual(expect.arrayContaining(["--resume", "sid-1"]));
    expect(fresh?.status).toBe("running");
  });

  it("asks first while Claude works; Not now stops nothing", async () => {
    const working = claudeTile({ readiness: undefined });
    act(() => useTiles.setState({ byWorkspace: { ws: { tiles: [working], expandedTileId: null, detailTileId: null } } }));
    const view = renderUi(<div />, { fixtures: { pty_kill: null } });
    const asked = restartForTheme(working);
    expect(await screen.findByText(RESTART_WHILE_WORKING.title)).toBeTruthy();
    await view.user.click(screen.getByRole("button", { name: RESTART_WHILE_WORKING.cancelLabel }));
    expect(await asked).toBeNull();
    expect(view.tauri.callsOf("pty_kill")).toHaveLength(0);
  });

  it("at Ready restarts without asking", async () => {
    const idle = claudeTile({ readiness: IDLE } as unknown as Partial<Tile>);
    act(() => useTiles.setState({ byWorkspace: { ws: { tiles: [idle], expandedTileId: null, detailTileId: null } } }));
    const view = renderUi(<div />, {
      fixtures: {
        pty_kill: () => {
          setTimeout(() => useTiles.getState().markExited("t1", 0), 10);
          return null;
        },
        terminal_resume_check: { kind: "ready" },
      },
    });
    await restartForTheme(idle);
    expect(screen.queryByText(RESTART_WHILE_WORKING.title)).toBeNull();
    expect(view.tauri.callsOf("pty_kill")).toHaveLength(1);
  });
});

describe("Restart on the Builder", () => {
  it("is the Builder's own close, then Resume", async () => {
    useBuilder.setState({ byCard: {} });
    const stub = tauri();
    stub.allowUnhandled();
    stub.fixture("builder_close", null);
    stub.fixture("builder_resume", null);
    expect(await restartBuilderSession("ws", "card-1")).toBe(true);
    const order = stub.calls.map((c) => c.cmd).filter((c) => c === "builder_close" || c === "builder_resume");
    expect(order).toEqual(["builder_close", "builder_resume"]);
  });

  it("doesn't resume when the close failed", async () => {
    useBuilder.setState({ byCard: {} });
    const stub = tauri();
    stub.allowUnhandled();
    stub.fixture("builder_close", () => {
      throw new Error("no");
    });
    stub.fixture("builder_resume", null);
    expect(await restartBuilderSession("ws", "card-1")).toBe(false);
    await waitFor(() => expect(stub.callsOf("builder_close")).toHaveLength(1));
    expect(stub.callsOf("builder_resume")).toHaveLength(0);
  });
});
