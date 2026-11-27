// Terminals block P5: History › Sessions — the Claude and Codex sessions
// opened in Terminals in every workspace, last 28 days, most recently used
// first (1.174.0 E9): Title · Kind · Workspace · Last used · Duration, and Resume (Show for one running;
// disabled, with why, when its conversation is gone).
import { describe, expect, it, vi } from "vitest";
import { ActivityView } from "../components/ActivityView";
import { useWorkspaces, type Workspace } from "../store/workspaceStore";
import { useTiles } from "../store/tileStore";
import { useUi } from "../store/uiStore";
import type { ActivityFeed, ShellEnvInfo, TerminalHistorySession } from "../ipc";
import { FILE_GONE } from "../lib/terminalConversations";
import { act, renderUi, screen, waitFor, within } from "./render";

vi.mock("../components/Terminal", () => ({ Terminal: () => <div /> }));

const NOW = Date.now();
const MIN = 60_000;
const ws = (id: string, name: string): Workspace => ({
  id,
  name,
  cwd: `/code/${id}`,
  createdAt: 1,
  lastOpenedAt: 1,
  openFiles: [],
  activeFile: null,
});

const FEED: ActivityFeed = {
  generatedAt: NOW,
  windowDays: 28,
  stats: { runs: 0, failedRuns: 0, ships: 0, verifyPassed: 0, verifyTotal: 0, costUsd: 0, medianRunSecs: null },
  rows: [],
  truncated: false,
} as unknown as ActivityFeed;

const env = { claudePath: "/c/claude", codexPath: "/c/codex", codexHealthy: true } as ShellEnvInfo;

function s(over: Partial<TerminalHistorySession> & { id: string }): TerminalHistorySession {
  return { workspaceId: "a", kind: "claude", cwd: "/code/a", startedAt: NOW - 60 * MIN, live: false, resumable: true, cliSessionId: "c-1", ...over };
}

const SESSIONS: TerminalHistorySession[] = [
  s({ id: "1", title: "Dark mode", endedAt: NOW - 48 * MIN }),
  // Windows walk: a live Codex tile has no conversation id before its first turn.
  s({ id: "2", kind: "codex", cliSessionId: undefined, startedAt: NOW - 5 * MIN, live: true, ptyId: "pty-7", title: "Cache tests" }),
  s({ id: "3", cliSessionId: "c-gone", title: "Old work", startedAt: NOW - 2 * 86_400_000, endedAt: NOW - 2 * 86_400_000 + 3 * MIN, resumable: false, gone: "conversation" }),
  s({ id: "old", title: "Older", startedAt: NOW - 30 * 86_400_000, endedAt: NOW - 30 * 86_400_000 + MIN }),
  s({ id: "4", workspaceId: "b", cwd: "/code/b", cliSessionId: "c-b", startedAt: NOW - 30 * MIN, endedAt: NOW - 10 * MIN, title: "Site header" }),
  // Walk: a resumed session says so, beside the one it picked up.
  s({ id: "5", title: "Dark mode", resumedFrom: "1", startedAt: NOW - 20 * MIN, endedAt: NOW - 15 * MIN }),
];

function setup() {
  act(() => {
    useWorkspaces.setState({ workspaces: [ws("a", "Lyra"), ws("b", "Site")], activeId: "a" });
    useTiles.setState({ byWorkspace: {} });
    // QoL 11.1: Sessions is History's own tab.
    useUi.getState().setHistoryView({ tab: "sessions" });
  });
  const live = useTiles.getState().addCodexTile("a", "/code/a");
  act(() => useTiles.getState().setPtyId(live.id, "pty-7"));
  const r = renderUi(<ActivityView env={env} />, {
    fixtures: {
      activity_feed: FEED,
      terminal_sessions_history_all: { sessions: SESSIONS, unreadable: [] },
      terminal_resume_check: { kind: "ready" },
    },
  });
  r.tauri.allowUnhandled();
  return { r, live };
}

describe("History › Sessions", () => {
  it("lists Claude and Codex sessions of every workspace, most recently used first, with their duration", async () => {
    setup();
    const table = await screen.findByRole("table", { name: "Sessions" });
    // 1.174.0 E9 (T9): Resume…'s clock — last used, most recent first.
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual([
      "Title",
      "Kind",
      "Workspace",
      "Last used",
      "Duration",
      "",
    ]);
    // 1.168.1 (A2): the action column fits "Open session" (md, 144 px; sm
    // cut it at the right edge); the workspace gave it the width.
    const heads = within(table).getAllByRole("columnheader");
    expect(heads[5].className).toContain("ux-list-col--md");
    expect(heads[2].className).toContain("ux-list-col--sm");
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent))).toEqual([
      ["Cache tests", "Codex", "Lyra", "now", "Running", "Open session"],
      ["Site header", "Claude", "Site", "10m", "20 min", "Resume"],
      ["Dark mode", "Claude · resumed", "Lyra", "15m", "5 min", "Resume"],
      ["Dark mode", "Claude", "Lyra", "48m", "12 min", "Resume"],
      ["Old work", "Claude", "Lyra", "2d", "3 min", "Resume" + FILE_GONE],
    ]);
    const gone = rows[4].querySelector("button") as HTMLButtonElement;
    expect(gone.disabled).toBe(true);
    // The reason is the button's description too (a disabled button shows no tooltip).
    expect(document.getElementById(gone.getAttribute("aria-describedby")!)?.textContent).toBe(FILE_GONE);
    expect(rows[4].querySelectorAll("td")[5].querySelector("[title]")?.getAttribute("title")).toBe(FILE_GONE);
  });

  it("dates a session with no end by its conversation's last write, from the same call", async () => {
    act(() => {
      useWorkspaces.setState({ workspaces: [ws("a", "Lyra")], activeId: "a" });
      useUi.getState().setHistoryView({ tab: "sessions" });
    });
    const r = renderUi(<ActivityView env={env} />, {
      fixtures: {
        activity_feed: FEED,
        terminal_sessions_history_all: {
          sessions: [
            s({ id: "q", cliSessionId: "c-q", title: "Quit open", startedAt: NOW - 3 * 86_400_000, lastWriteAt: NOW - 20 * MIN }),
            s({ id: "e", cliSessionId: "c-e", title: "Ended", startedAt: NOW - 90 * MIN, endedAt: NOW - 60 * MIN }),
          ],
          unreadable: [],
        },
      },
    });
    r.tauri.allowUnhandled();
    const table = await screen.findByRole("table", { name: "Sessions" });
    await waitFor(() =>
      expect(
        within(table)
          .getAllByRole("row")
          .slice(1)
          .map((tr) => [...tr.querySelectorAll("td")].slice(0, 4).map((td) => td.textContent)),
      ).toEqual([
        ["Quit open", "Claude", "Lyra", "20m"],
        ["Ended", "Claude", "Lyra", "1h"],
      ]),
    );
    // Round 1: one call — no scan of every conversation per workspace.
    expect(r.tauri.callsOf("terminal_conversations")).toHaveLength(0);
  });

  it("Resume opens the conversation in a new tile where it ran; Show brings up the running one", async () => {
    const { r, live } = setup();
    const table = await screen.findByRole("table", { name: "Sessions" });
    await r.user.click(within(table).getByRole("button", { name: "Resume Site header" }));
    await waitFor(() => expect(useTiles.getState().byWorkspace.b?.tiles).toHaveLength(1));
    const t = useTiles.getState().byWorkspace.b.tiles[0];
    expect([t.kind, t.args, t.cwd, t.label]).toEqual(["claude", ["--resume", "c-b"], "/code/b", "Site header"]);
    expect(useUi.getState().centerMode.b).toBe("terminals");

    await r.user.click(within(table).getByRole("button", { name: "Open session Cache tests" }));
    await waitFor(() => expect(useTiles.getState().byWorkspace.a.expandedTileId).toBe(live.id));
    expect(useTiles.getState().byWorkspace.a.tiles).toHaveLength(1);
  });

  it("says so when the sessions can't be read", async () => {
    act(() => {
      useWorkspaces.setState({ workspaces: [ws("a", "Lyra")], activeId: "a" });
      useUi.getState().setHistoryView({ tab: "sessions" });
    });
    const r = renderUi(<ActivityView env={env} />, {
      fixtures: {
        activity_feed: FEED,
        terminal_sessions_history_all: () => {
          throw new Error("boom");
        },
      },
    });
    r.tauri.allowUnhandled();
    expect(await screen.findByText(/couldn't read the sessions just now/)).toBeTruthy();
  });

  it("names a workspace whose record doesn't parse", async () => {
    act(() => {
      useWorkspaces.setState({ workspaces: [ws("a", "Lyra")], activeId: "a" });
      useUi.getState().setHistoryView({ tab: "sessions" });
    });
    const r = renderUi(<ActivityView env={env} />, {
      fixtures: { activity_feed: FEED, terminal_sessions_history_all: { sessions: [], unreadable: ["a"] } },
    });
    r.tauri.allowUnhandled();
    expect(await screen.findByText(/The sessions of Lyra couldn't be read/)).toBeTruthy();
  });

  // QoL 11.1 (F8): Sessions is a tab, reached at once, and History's filters apply to it.
  it("is History's own tab, with its count, and follows the workspace and text filter", async () => {
    const { r } = setup();
    const table = await screen.findByRole("table", { name: "Sessions" });
    expect(within(table).getAllByRole("row")).toHaveLength(6);
    const tabs = screen.getByRole("group", { name: "Show" });
    expect((await within(tabs).findByRole("button", { name: "Sessions 5" })).getAttribute("aria-pressed")).toBe("true");

    await r.user.type(screen.getByRole("searchbox", { name: "Filter History" }), "dark");
    await waitFor(() => expect(within(table).getAllByRole("row")).toHaveLength(3));
    expect(await within(tabs).findByRole("button", { name: "Sessions 2" })).toBeTruthy();

    await r.user.clear(screen.getByRole("searchbox", { name: "Filter History" }));
    await r.user.selectOptions(screen.getByRole("combobox", { name: "Workspace" }), "b");
    await waitFor(() => expect(within(table).getAllByRole("row")).toHaveLength(2));
    expect(within(table).getByText("Site header")).toBeTruthy();

    await r.user.type(screen.getByRole("searchbox", { name: "Filter History" }), "nothing like it");
    expect(await screen.findByText("No session matches the filter.")).toBeTruthy();
  });

  // Walk (block 11): a tab not shown is not in the accessibility tree either.
  it("renders nothing of Sessions on another tab, though its tab keeps its count", async () => {
    const { r } = setup();
    await screen.findByRole("table", { name: "Sessions" });
    await r.user.type(screen.getByRole("searchbox", { name: "Filter History" }), "nothing like it");
    expect(await screen.findByText("No session matches the filter.")).toBeTruthy();
    await r.user.click(within(screen.getByRole("group", { name: "Show" })).getByRole("button", { name: /^Runs/ }));
    await waitFor(() => expect(screen.queryByText("No session matches the filter.")).toBeNull());
    expect(screen.queryByRole("table", { name: "Sessions" })).toBeNull();
    expect(document.body.textContent).not.toContain("The Claude and Codex sessions you opened");
    expect(within(screen.getByRole("group", { name: "Show" })).getByRole("button", { name: "Sessions 0" })).toBeTruthy();
  });
});
