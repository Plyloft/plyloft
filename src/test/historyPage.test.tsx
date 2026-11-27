// UX-4.5: History is a page on the one scale — the header "History", the
// numbers as a small facts block, then a ListView: Title · Workspace ·
// Result · When. A row with a card opens it; a standalone run opens its output.
//
// QoL 11.1 (F8): tabs — Runs, Ships, Checks, Sessions, Discussions — with a
// workspace and a text filter; every number is counted from the rows shown.
// QoL 11.2 (D9): no dollar figure anywhere — Plyloft can't know what was billed.
import { describe, expect, it, vi } from "vitest";
import { ActivityView } from "../components/ActivityView";
import { useWorkspaces, type Workspace } from "../store/workspaceStore";
import { useUi } from "../store/uiStore";
import { useBoard } from "../store/boardStore";
import type { ActivityFeed, ActivityRow } from "../ipc";
import { act, renderUi, screen, tauri, waitFor, within } from "./render";

const NOW = Date.now();
const NO_SESSIONS = { sessions: [], unreadable: [] };

const ws = (id: string, name: string): Workspace => ({
  id,
  name,
  cwd: `/code/${id}`,
  createdAt: 1,
  lastOpenedAt: 1,
  openFiles: [],
  activeFile: null,
});

function row(over: Partial<ActivityRow> & Pick<ActivityRow, "id" | "title" | "state">): ActivityRow {
  return {
    kind: "run",
    detail: "",
    workspaceId: "l",
    workspaceName: "Lyra",
    cardId: null,
    runId: null,
    at: NOW - 2 * 3_600_000,
    count: 1,
    ...over,
  };
}

const FEED: ActivityFeed = {
  generatedAt: NOW,
  windowDays: 28,
  stats: { medianRunSecs: 240 },
  rows: [
    row({ id: "s1", kind: "ship", title: "Fix **login** redirect", state: "shipped", cardId: "c1", count: 2, detail: "v1 · abc · no checks set up" }),
    row({ id: "b1", kind: "build", title: "Fix **login** redirect", state: "built", cardId: "c1", count: 3 }),
    row({ id: "r1", title: "Nightly sweep", state: "failed", runId: "run-1" }),
    // GH #309: a raw run state reads as plain words.
    row({ id: "w1", kind: "swarm", title: "Swarm on search", state: "max_iter" }),
    // A card whose checks failed, then passed: its latest, "last of 2 runs".
    row({ id: "v1", kind: "verify", title: "Header", state: "passed", cardId: "c2", workspaceId: "s", workspaceName: "Site", count: 2 }),
    row({ id: "v2", kind: "verify", title: "Footer", state: "failed", cardId: "c3", workspaceId: "s", workspaceName: "Site" }),
    row({ id: "d1", kind: "discussion", title: "Pick an API", state: "completed" }),
  ],
  truncated: false,
  tabTotals: { runs: 3, ships: 1, checks: 2, discussions: 1 },
};

/** The backend applies the workspace filter: so does this fixture. */
function feedFor(feed: ActivityFeed) {
  return (args: { workspaceId?: string | null } | undefined) => {
    const id = args?.workspaceId ?? null;
    if (id == null) return feed;
    const rows = feed.rows.filter((r) => r.workspaceId === id);
    const tabTotals: Record<string, number> = {};
    for (const r of rows) {
      const tab = r.kind === "ship" ? "ships" : r.kind === "verify" ? "checks" : r.kind === "discussion" ? "discussions" : "runs";
      tabTotals[tab] = (tabTotals[tab] ?? 0) + 1;
    }
    return { ...feed, rows, tabTotals };
  };
}

function cells(table: HTMLElement): string[][] {
  return within(table)
    .getAllByRole("row")
    .slice(1)
    .map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent ?? ""));
}

function setup(feed: ActivityFeed = FEED) {
  act(() => useWorkspaces.setState({ workspaces: [ws("l", "Lyra"), ws("s", "Site")], activeId: "l" }));
  return renderUi(<ActivityView />, {
    fixtures: { activity_feed: feedFor(feed), terminal_sessions_history_all: NO_SESSIONS },
  });
}

const facts = () => document.querySelector(".ux-props") as HTMLElement;
const tabs = () => screen.getByRole("group", { name: "Show" });
const tabLabels = () => within(tabs()).getAllByRole("button").map((b) => b.textContent);

describe("the History page", () => {
  it("opens on Runs — Builder rounds included — with tabs whose counts are what they list", async () => {
    const r = setup();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("History");
    const table = await screen.findByRole("table", { name: "Runs" });
    // D9: no Cost column.
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual([
      "Title",
      "Workspace",
      "Result",
      "When",
    ]);
    expect(cells(table)).toEqual([
      ["Fix login redirect", "Lyra", "Built · 3 rounds", "2h"],
      ["Nightly sweep", "Lyra", "Failed", "2h"],
      ["Swarm on search", "Lyra", "Hit the step limit", "2h"],
    ]);
    await waitFor(() =>
      expect(tabLabels()).toEqual(["Runs 3", "Ships 1", "Checks 2", "Sessions 0", "Discussions 1"]),
    );

    // The numbers, as facts — counted from the rows, one unit each.
    expect(within(facts()).getByText("2, 2 failed")).toBeTruthy();
    expect(within(facts()).getByText("1 card, 3 rounds")).toBeTruthy();
    // 1.174.0 (TX1, T5): Builder first, then the other AI runs — 1 card and
    // 2 runs are the Runs tab's 3.
    const labels = [...facts().querySelectorAll("dt")].map((d) => d.textContent?.trim());
    expect(labels.slice(0, 2)).toEqual(["Builder", "Other AI runs"]);
    expect(labels).not.toContain("Agent runs");
    expect(within(facts()).getByText("1 of 2 cards passed their latest checks")).toBeTruthy();
    expect(within(facts()).getByText("2 times, 1 card")).toBeTruthy();
    // GH #309: a duration on the one short form, no seconds.
    expect(within(facts()).getByText("4m")).toBeTruthy();
    expect(within(facts()).queryByText("Spent")).toBeNull();
    expect(document.body.textContent).not.toMatch(/\$\d/);

    // A card's row opens the card.
    await r.user.click(within(table).getByRole("button", { name: "Fix login redirect" }));
    expect(useUi.getState().selectedCardId.l).toBe("c1");
  });

  it("lists a shipped card once, its no-checks folded in, and a card's checks as their latest", async () => {
    const r = setup();
    await screen.findByRole("table", { name: "Runs" });
    await r.user.click(within(tabs()).getByRole("button", { name: "Ships 1" }));
    const ships = await screen.findByRole("table", { name: "Ships" });
    expect(cells(ships)).toEqual([["Fix login redirect", "Lyra", "Shipped · 2 times", "2h"]]);
    expect(within(ships).queryByText("No checks set up")).toBeNull();

    await r.user.click(within(tabs()).getByRole("button", { name: "Checks 2" }));
    const checks = await screen.findByRole("table", { name: "Checks" });
    expect(cells(checks).map((c) => c[2])).toEqual(["Checks passed · last of 2 runs", "Failed"]);
  });

  it("asks the backend for one workspace, and filters every tab and number by text", async () => {
    const r = setup();
    await screen.findByRole("table", { name: "Runs" });
    await r.user.selectOptions(screen.getByRole("combobox", { name: "Workspace" }), "s");
    await waitFor(() => {
      const calls = r.tauri.callsOf("activity_feed");
      expect(calls[calls.length - 1]?.args).toEqual({ workspaceId: "s" });
    });
    await waitFor(() =>
      expect(tabLabels()).toEqual(["Runs 0", "Ships 0", "Checks 2", "Sessions 0", "Discussions 0"]),
    );
    expect(await screen.findByText("Nothing here matches the filter.")).toBeTruthy();
    expect(within(facts()).getByText("1 of 2 cards passed their latest checks")).toBeTruthy();
    // The lede stays, and names the workspace.
    expect(screen.getByText(/What ran and shipped in Site over the last 28 days/)).toBeTruthy();

    await r.user.selectOptions(screen.getByRole("combobox", { name: "Workspace" }), "__all__");
    await r.user.type(screen.getByRole("searchbox", { name: "Filter History" }), "nightly");
    const table = await screen.findByRole("table", { name: "Runs" });
    await waitFor(() => expect(cells(table).map((c) => c[0])).toEqual(["Nightly sweep"]));
    expect(within(tabs()).getByRole("button", { name: "Runs 1" })).toBeTruthy();
    // A typed filter has no typical run of its own.
    expect(within(facts()).queryByText("4m")).toBeNull();
  });

  it("says when a tab was cut: its whole count, the latest it lists, and + under a text filter", async () => {
    const r = setup({ ...FEED, truncated: true, tabTotals: { ...FEED.tabTotals, runs: 512 } });
    await screen.findByRole("table", { name: "Runs" });
    await waitFor(() => expect(within(tabs()).getByRole("button", { name: "Runs 512" })).toBeTruthy());
    expect(screen.getByText(/This tab lists the latest 3 of 512, and the numbers count those\./)).toBeTruthy();
    await r.user.type(screen.getByRole("searchbox", { name: "Filter History" }), "nightly");
    expect(await within(tabs()).findByRole("button", { name: "Runs 1+" })).toBeTruthy();
    // A tab that wasn't cut says nothing of the kind.
    await r.user.click(within(tabs()).getByRole("button", { name: /^Ships/ }));
    expect(screen.queryByText(/This tab lists the latest/)).toBeNull();
  });

  it("keeps a deleted card's runs, marked, as rows that open nothing (1.168.1 A4)", async () => {
    setup({
      ...FEED,
      rows: [
        row({ id: "b9", kind: "build", title: "Add a dark mode toggle", state: "built", cardId: null, count: 2, cardDeleted: true }),
        ...FEED.rows,
      ],
      tabTotals: { ...FEED.tabTotals, runs: 4 },
    });
    const table = await screen.findByRole("table", { name: "Runs" });
    expect(cells(table)[0]).toEqual(["Add a dark mode toggle · card deleted", "Lyra", "Built · 2 rounds", "2h"]);
    // Not a button: nothing to open.
    expect(within(table).queryByRole("button", { name: /Add a dark mode toggle/ })).toBeNull();
    // Still counted: the rounds happened.
    expect(within(facts()).getByText("2 cards, 5 rounds")).toBeTruthy();
  });

  it("reads again when a board changes while it is open, once per burst (1.168.1 A4 walk)", async () => {
    let feed: ActivityFeed = FEED;
    act(() => useWorkspaces.setState({ workspaces: [ws("l", "Lyra"), ws("s", "Site")], activeId: "l" }));
    renderUi(<ActivityView />, {
      fakeTimers: true,
      fixtures: { activity_feed: () => feed, terminal_sessions_history_all: NO_SESSIONS },
    });
    await act(async () => {
      vi.advanceTimersByTime(10);
    });
    const reads = () => tauri().callsOf("activity_feed").length;
    const first = reads();
    feed = {
      ...FEED,
      rows: FEED.rows.map((r) => (r.id === "b1" ? { ...r, cardId: null, cardDeleted: true } : r)),
    };
    await act(async () => {
      tauri().emit("kanban://changed", "l");
      tauri().emit("kanban://changed", "l");
    });
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    expect(reads()).toBe(first + 1);
    const table = screen.getByRole("table", { name: "Runs" });
    expect(cells(table)[0][0]).toBe("Fix login redirect · card deleted");
  });

  it("mounted within a second of a delete, marks the card's rows at once, and gives them back on Undo (1.168.1 A4, Windows walk)", async () => {
    // The delete runs only when its Undo window ends (`deferCardRemoval`
    // marks it pending); the feed still lists the card as it was.
    act(() => useBoard.setState({ pendingRemoval: { c1: "delete" } }));
    setup();
    const table = await screen.findByRole("table", { name: "Runs" });
    expect(cells(table)[0][0]).toBe("Fix login redirect · card deleted");
    expect(within(table).queryByRole("button", { name: /Fix login redirect/ })).toBeNull();
    // Undo: the card is back, and so is its link.
    act(() => useBoard.setState({ pendingRemoval: {} }));
    expect(cells(screen.getByRole("table", { name: "Runs" }))[0][0]).toBe("Fix login redirect");
    expect(within(screen.getByRole("table", { name: "Runs" })).getByRole("button", { name: "Fix login redirect" })).toBeTruthy();
  });

  it("opens a standalone run's output from its row", async () => {
    const r = setup();
    const table = await screen.findByRole("table", { name: "Runs" });
    await r.user.click(within(table).getByRole("button", { name: "Nightly sweep" }));
    expect(useUi.getState().historySheet).toEqual({ kind: "run", workspaceId: "l", runId: "run-1" });
    // A swarm row without a card opens nothing.
    expect(within(table).queryByRole("button", { name: "Swarm on search" })).toBeNull();
  });

  it("starts from the plain view when opened normally after a search set its filter", () => {
    act(() => {
      useUi.getState().setHistoryView({ tab: "sessions", workspaceId: "s", text: "Dark mode", fromSearch: true });
      useUi.getState().setCenterMode("l", "activity");
    });
    expect(useUi.getState().historyView).toEqual({ tab: "runs", workspaceId: null, text: "" });
    // A filter the person set stays.
    act(() => {
      useUi.getState().setHistoryView({ tab: "checks", text: "login" });
      useUi.getState().setCenterMode("l", "activity");
    });
    expect(useUi.getState().historyView).toMatchObject({ tab: "checks", text: "login" });
  });

  it("says so when nothing ran", async () => {
    setup({ ...FEED, stats: { medianRunSecs: null }, rows: [], tabTotals: {} });
    expect(
      await screen.findByText(
        "No run in the last 28 days. A card's Builder rounds and the runs started from the Board land here.",
      ),
    ).toBeTruthy();
  });
});
