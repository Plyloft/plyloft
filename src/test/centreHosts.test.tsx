// 2026-09-30 walk (next11/skills-b 147890ae, Plyloft Test on a locked Mac):
// opening any card left the centre blank — the Board hidden behind the open
// card, and the card host empty, with nothing in the log. The workspace's
// staged mount advanced only on `requestAnimationFrame`, which WebKit does
// not send to a page it is not painting, so the card host (mounted at the
// last stage) never came. And a centre view that throws while drawing must
// show an ErrorBlock and log, never blank the window.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logged = vi.hoisted(() => [] as string[]);
vi.mock("@tauri-apps/plugin-log", () => ({
  error: (m: string) => {
    logged.push(m);
    return Promise.resolve();
  },
  warn: () => Promise.resolve(),
  info: () => Promise.resolve(),
  debug: () => Promise.resolve(),
  trace: () => Promise.resolve(),
}));
const boom = vi.hoisted(() => ({ board: false }));
vi.mock("../components/CardDetailPanel", () => ({
  CardDetailPanel: ({ workspaceId }: { workspaceId: string }) => (
    <h1>{`card page of ${workspaceId}`}</h1>
  ),
}));
vi.mock("../components/KanbanBoard", () => ({
  KanbanBoard: () => {
    if (boom.board) {
      // The shape of the real failure class: a field real data lacks.
      const card = {} as { builder: { ptyId: string } };
      return <p>{card.builder.ptyId}</p>;
    }
    return <h1>the board</h1>;
  },
}));
vi.mock("../components/TileGrid", () => ({
  TileGrid: () => <p>tiles</p>,
  TileGridEmpty: () => null,
}));

import { NewWorkspaceShell } from "../components/NewWorkspaceShell";
import { DEFAULT_SETTINGS, useSettings } from "../store/settingsStore";
import { useUi } from "../store/uiStore";
import type { Workspace } from "../store/workspaceStore";
import { act, renderUi, screen, tauri, waitFor } from "./render";

const ws: Workspace = {
  id: "w1",
  name: "groupb-walk",
  cwd: "/tmp/groupb-walk",
  createdAt: 0,
  lastOpenedAt: 0,
  openFiles: [],
  activeFile: null,
};

function renderShell() {
  tauri().allowUnhandled();
  tauri().fixture("drain_status", { draining: false, startedAt: null });
  tauri().fixture("ship_pending_count", 0);
  tauri().fixture("ship_pending_cards", null);
  tauri().fixture("ship_unverified_count", 0);
  act(() => {
    useSettings.setState({ settings: DEFAULT_SETTINGS, loaded: true });
    useUi.setState({ centerMode: { w1: "board" }, selectedCardId: { w1: null } });
  });
  return renderUi(
    <NewWorkspaceShell env={null} warmed={new Set(["w1"])} workspaces={[ws]} activeId="w1" />,
  );
}

beforeEach(() => {
  logged.length = 0;
  boom.board = false;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the centre when the page gets no animation frames", () => {
  it("still mounts the card page when a card is opened", async () => {
    // A locked screen / covered window: WebKit sends no frames at all.
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    renderShell();
    expect(screen.getByRole("heading", { name: "the board" })).toBeTruthy();
    act(() => {
      useUi.setState({ selectedCardId: { w1: "card-1" } });
    });
    await waitFor(() => expect(screen.getByRole("heading", { name: "card page of w1" })).toBeTruthy(), {
      timeout: 2000,
    });
  });
});

describe("a centre view that fails to draw", () => {
  it("shows an ErrorBlock in its place, logs the error and keeps the sidebar", async () => {
    boom.board = true;
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    renderShell();
    quiet.mockRestore();
    expect(screen.getByRole("group", { name: "The Board could not be shown." })).toBeTruthy();
    expect(screen.getByText(/Your cards, files and running sessions are as they were/)).toBeTruthy();
    expect(screen.getByRole("complementary", { name: "Sidebar" })).toBeTruthy();
    expect(logged.some((l) => l.startsWith("centre render error (The Board):"))).toBe(true);

    // Try again draws it once the cause is gone.
    boom.board = false;
    act(() => {
      screen.getByRole("button", { name: "Try again" }).click();
    });
    expect(screen.getByRole("heading", { name: "the board" })).toBeTruthy();
  });
});
