// 1.176.4 (owner, 2026-11-23): a scheduled update held by a session says why,
// in one line where it waits — the sidebar's row and Settings › Updates —
// in the quit sheet's words, with the way to the session that asks. The line
// follows the work: it goes when the reason does.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UpdateStatusRow, setUpdateFlowForTests } from "../components/UpdatePrompt";
import { UpdatesRow } from "../components/settings/ProfilePage";
import { UpdateFlow, type UpdateHandle } from "../lib/updateFlow";
import { useTiles, type Tile } from "../store/tileStore";
import { useUi } from "../store/uiStore";
import { freshBuilderScreens, pollSessionBlocks, useBuilder } from "../store/builderStore";
import type { BuilderSessionScreen } from "../lib/builderScreensIpc";
import type { KanbanCard } from "../ipc";
import { BOARD_WS, boardCard, seedBoard } from "./boardFixtures";
import { act, renderUi, screen, tauri, waitFor } from "./render";

const TILE_WS = "ws-tiles";

function handle(version: string): UpdateHandle {
  // The quiet download never ends: the update stays scheduled.
  return { version, download: () => new Promise<void>(() => {}), install: async () => {}, close: async () => {} };
}

async function scheduled(): Promise<UpdateFlow> {
  const flow = new UpdateFlow({ check: async () => handle("1.177.0"), relaunch: async () => {}, log: { info: () => {}, error: () => {} } });
  setUpdateFlowForTests(flow);
  await flow.runCheck("launch");
  flow.installWhenIdle();
  expect(flow.getState().kind).toBe("scheduled");
  return flow;
}

function claudeTile(id: string, patch: Partial<Tile>): Tile {
  const now = Date.now();
  return {
    id,
    workspaceId: TILE_WS,
    kind: "claude",
    status: "running",
    label: id,
    ptyId: `pty-${id}`,
    startedAt: now - 60_000,
    lastOutputAt: now - 30_000,
    ...patch,
  } as unknown as Tile;
}

function tilesAre(tiles: Tile[]) {
  act(() => useTiles.setState({ byWorkspace: { [TILE_WS]: { tiles, expandedTileId: null, detailTileId: null } } } as never));
}

const asking = () => claudeTile("t1", { question: "trust" } as Partial<Tile>);
const working = () =>
  claudeTile("t2", {
    readiness: { lastOutputAt: Date.now(), matcherIdle: false, leftReadyAt: Date.now() - 5_000, running: true },
  } as Partial<Tile>);

let poll = 0;
async function backendSays(blocks: unknown[], screens: BuilderSessionScreen[]) {
  tauri().fixture("builder_session_blocks", blocks);
  tauri().fixture("builder_session_screens", screens);
  poll += 10_000;
  await act(() => pollSessionBlocks(97_000_000 + poll));
}

beforeEach(() => {
  tauri().allowUnhandled();
  seedBoard([]);
});

afterEach(async () => {
  setUpdateFlowForTests(null);
  act(() => useTiles.setState({ byWorkspace: {} }));
  useBuilder.setState({ byCard: {}, trustAsking: {}, sessionBlocks: {} });
  seedBoard([]);
  poll += 10_000;
  await act(() => pollSessionBlocks(97_000_000 + poll));
});

describe("the update's waiting line", () => {
  it("a session that asks: the sidebar says so and opens it; the line goes when the question does", async () => {
    await scheduled();
    tilesAre([asking()]);
    const r = renderUi(<UpdateStatusRow />);
    expect(screen.getByText("Plyloft 1.177.0 installs when your work is done")).toBeTruthy();
    expect(screen.getByText("Waiting: 1 session asks you something.")).toBeTruthy();
    await r.user.click(screen.getByRole("button", { name: "Open session: t1" }));
    expect(useTiles.getState().byWorkspace[TILE_WS]?.expandedTileId).toBe("t1");
    // Answered: the line goes at the next look, the row stays.
    tilesAre([claudeTile("t1", {})]);
    await waitFor(() => expect(screen.queryByText(/^Waiting:/)).toBeNull(), { timeout: 3_000 });
    expect(screen.getByText("Plyloft 1.177.0 installs when your work is done")).toBeTruthy();
  });

  it("work in flight: the working words, and nothing to open", async () => {
    await scheduled();
    tilesAre([working()]);
    renderUi(<UpdateStatusRow />);
    expect(screen.getByText("Waiting: 1 session is working.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Open/ })).toBeNull();
  });

  it("a Builder whose card isn't shown, stopped at a question, is opened on its card; it goes first", async () => {
    await scheduled();
    seedBoard([
      boardCard("c1", {
        columnId: "in_progress",
        builder: { vendor: "claude", bypass: false, ptyId: "pty-c1", sessionLost: false, startedAt: Date.now() - 600_000, snapshots: [] },
      } as Partial<KanbanCard>),
    ]);
    await backendSays(
      [{ key: "c1", workspaceId: BOARD_WS, vendor: "claude", kind: "trust" }],
      [{ key: "c1", vendor: "claude", lastOutputAt: Date.now() - 1_000, exited: false }],
    );
    tilesAre([asking(), working()]);
    const r = renderUi(<UpdateStatusRow />);
    expect(screen.getByText("Waiting: 1 session is working · 2 sessions ask you something.")).toBeTruthy();
    await r.user.click(screen.getByRole("button", { name: "Open the Builder: c1" }));
    expect(useUi.getState().selectedCardId[BOARD_WS]).toBe("c1");
    expect(useUi.getState().cardStep.c1).toBe("run");
  });

  it("Settings › Updates says it too, and its press leaves Settings for the session", async () => {
    await scheduled();
    tilesAre([asking()]);
    act(() => useUi.getState().setSettingsOverlayOpen(true));
    const r = renderUi(<UpdatesRow />);
    expect(screen.getByText("1.177.0 installs when your work is done")).toBeTruthy();
    expect(screen.getByText(/Waiting: 1 session asks you something\./)).toBeTruthy();
    await r.user.click(screen.getByRole("button", { name: "Open session: t1" }));
    expect(useUi.getState().settingsOverlayOpen).toBe(false);
    expect(useTiles.getState().byWorkspace[TILE_WS]?.expandedTileId).toBe("t1");
  });

  it("nothing holds it, or no update is scheduled: no line", async () => {
    const flow = new UpdateFlow({ check: async () => handle("1.177.0"), relaunch: async () => {}, log: { info: () => {}, error: () => {} } });
    setUpdateFlowForTests(flow);
    await flow.runCheck("launch");
    act(() => flow.later());
    expect(flow.getState().kind).toBe("available");
    tilesAre([asking()]);
    const r = renderUi(<UpdateStatusRow />);
    expect(screen.getByText("Plyloft 1.177.0 is available")).toBeTruthy();
    expect(screen.queryByText(/^Waiting:/)).toBeNull();
    r.unmount();
    act(() => flow.openFromBanner());
    act(() => flow.installWhenIdle());
    tilesAre([claudeTile("t1", {})]);
    renderUi(<UpdateStatusRow />);
    expect(screen.getByText("Plyloft 1.177.0 installs when your work is done")).toBeTruthy();
    expect(screen.queryByText(/^Waiting:/)).toBeNull();
  });

  // Review of 1.176.4, should-fixes and missing cases.
  function buildOn(id: string, vendor: "claude" | "codex" = "claude") {
    seedBoard([
      boardCard(id, {
        columnId: "in_progress",
        builder: { vendor, bypass: false, ptyId: `pty-${id}`, sessionLost: false, startedAt: Date.now() - 600_000, snapshots: [] },
      } as Partial<KanbanCard>),
    ]);
  }
  const CODEX_IDLE = ["• f5.txt has 15 lines.", "", "  Worked for 21s • 11:22", "", "", "› Ask Codex to do anything", "", "  ← for agents · ? for shortcuts"];
  const CODEX_TRUST = ["  Trust this folder? Codex can read, edit, and run files here.", "", "› 1. Trust and continue", "  2. Back to Agent Command Center", "", "  enter continue · esc back"];
  const drawn = (key: string, rows: string[], ago: number): BuilderSessionScreen => ({
    key,
    vendor: "codex",
    lastOutputAt: Date.now() - ago,
    exited: false,
    rows,
    contentChangedAt: Date.now() - ago,
  });

  it("an off-screen Builder judged from its screen rows to ask: the line names it and opens its card", async () => {
    await scheduled();
    buildOn("c1", "codex");
    await backendSays([], [drawn("c1", CODEX_TRUST, 60_000)]);
    const r = renderUi(<UpdateStatusRow />);
    expect(screen.getByText("Waiting: 1 session asks you something.")).toBeTruthy();
    await r.user.click(screen.getByRole("button", { name: "Open the Builder: c1" }));
    expect(useUi.getState().cardStep.c1).toBe("run");
  });

  it("a failed screen read counts the off-screen Builder as at work, as the idle look does", async () => {
    await scheduled();
    buildOn("c1", "codex");
    // Last good read: idle past its turn, quiet — nothing holds the update.
    await backendSays([], [drawn("c1", CODEX_IDLE, 60_000)]);
    const r = renderUi(<UpdateStatusRow />);
    expect(screen.queryByText(/^Waiting:/)).toBeNull();
    r.unmount();
    tauri().fixture("builder_session_screens", () => Promise.reject(new Error("no answer")));
    expect(await act(() => freshBuilderScreens())).toBe(false);
    renderUi(<UpdateStatusRow />);
    expect(screen.getByText("Waiting: 1 session is working.")).toBeTruthy();
    // A read that goes through again: the line goes.
    tauri().fixture("builder_session_screens", [drawn("c1", CODEX_IDLE, 60_000)]);
    expect(await act(() => freshBuilderScreens())).toBe(true);
    await waitFor(() => expect(screen.queryByText(/^Waiting:/)).toBeNull(), { timeout: 3_000 });
  });

  it("a session at its usage limit is opened last, and alone it has the grey dot", async () => {
    await scheduled();
    buildOn("c1");
    await backendSays(
      [{ key: "c1", workspaceId: BOARD_WS, vendor: "claude", kind: "usageLimit", resetsAt: "3pm" }],
      [{ key: "c1", vendor: "claude", lastOutputAt: Date.now() - 1_000, exited: false }],
    );
    tilesAre([asking()]);
    const r = renderUi(<UpdateStatusRow />);
    expect(screen.getByText("Waiting: 2 sessions ask you something.")).toBeTruthy();
    // The tile's real question comes before the Builder's limit.
    await r.user.click(screen.getByRole("button", { name: "Open session: t1" }));
    expect(useTiles.getState().byWorkspace[TILE_WS]?.expandedTileId).toBe("t1");
    r.unmount();
    // Only the limit: still named and openable, but not in the asks ink.
    tilesAre([]);
    const { container } = renderUi(<UpdateStatusRow />);
    expect(screen.getByText("Waiting: 1 session asks you something.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open the Builder: c1" })).toBeTruthy();
    expect(container.querySelector(".shell-dot--warn")).toBeNull();
    expect(container.querySelector(".shell-dot--empty")).toBeTruthy();
  });

  it("the press reads again: a session gone since the line was drawn opens nothing", async () => {
    await scheduled();
    tilesAre([asking()]);
    const r = renderUi(<UpdateStatusRow />);
    const button = screen.getByRole("button", { name: "Open session: t1" });
    tilesAre([]);
    await r.user.click(button);
    expect(useTiles.getState().byWorkspace[TILE_WS]?.expandedTileId ?? null).toBeNull();
  });

  it("the line goes, mounted, when the update stops being scheduled", async () => {
    const flow = await scheduled();
    tilesAre([asking()]);
    renderUi(<UpdateStatusRow />);
    expect(screen.getByText("Waiting: 1 session asks you something.")).toBeTruthy();
    act(() => flow.installNow());
    expect(flow.getState().kind).toBe("confirming");
    expect(screen.queryByText(/^Waiting:/)).toBeNull();
  });

  it("while the window is hidden the line isn't read again; shown again, it is", async () => {
    await scheduled();
    tilesAre([asking()]);
    renderUi(<UpdateStatusRow />);
    const setHidden = (hidden: boolean) => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
    };
    try {
      setHidden(true);
      tilesAre([claudeTile("t1", {})]);
      await new Promise((r) => setTimeout(r, 2_500));
      expect(screen.getByText("Waiting: 1 session asks you something.")).toBeTruthy();
      setHidden(false);
      await waitFor(() => expect(screen.queryByText(/^Waiting:/)).toBeNull(), { timeout: 3_000 });
    } finally {
      setHidden(false);
    }
  });
});
