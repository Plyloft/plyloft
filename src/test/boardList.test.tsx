// UX-5.6: Board | List. The List shows the same cards as the columns,
// grouped by attention, sortable, and "Ship selected" goes through the one
// Ship batch sheet with the ticked cards.
import { describe, expect, it, vi } from "vitest";
import { KanbanBoard } from "../components/KanbanBoard";
import { useBoard } from "../store/boardStore";
import { useUi } from "../store/uiStore";
import { act, renderUi, screen, waitFor, within } from "./render";
import { boardCard, boardWorkspace, seedBoard, BOARD_WS } from "./boardFixtures";
import { useWorkspaces } from "../store/workspaceStore";
import { useKanban } from "../store/kanbanStore";
import { useBuilder } from "../store/builderStore";
import { BATCH_SESSION_OPEN, SHIP_BATCH_RULE } from "../lib/boardSemantics";
import { BOARD_LIST_TICK_MS, LIST_NONE_IN_BATCH, LIST_SHIP_ONE } from "../components/BoardList";
import type { KanbanCard } from "../ipc";
import { FREE_GATES, setPlanGates } from "./planGates";

const verified = (id: string, title: string) =>
  boardCard(id, {
    title,
    columnId: "complete",
    lastRunStatus: "success",
    verifyStatus: "passed",
    shipStatus: "unshipped",
  });

function seed() {
  act(() =>
    seedBoard([
      boardCard("draft", { title: "Write the brief" }),
      verified("ship-a", "Fix login redirect"),
      verified("ship-b", "Void editor theme"),
      boardCard("running", {
        title: "Dark mode",
        columnId: "in_progress",
        lastRunStatus: "running",
        // GH #244: a running build has its session open.
        builder: { vendor: "codex", bypass: false, ptyId: "pty-1", sessionLost: false, startedAt: 1, snapshots: [] },
      }),
      boardCard("shipped", { title: "Toasts", columnId: "complete", shipStatus: "shipped" }),
    ]),
  );
}

const boardIds = () =>
  Array.from(document.querySelectorAll("[data-board-card-id]")).map((el) =>
    el.getAttribute("data-board-card-id"),
  );

// 1.172 A3 (C1 note): the List's times move on by themselves while a
// session runs, like the card page's waiting line.
describe("the List's clock", () => {
  it("reads its rows again every 30 s while a listed card has a live session", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      const at = Date.now();
      const reviewAt = at - 4 * 60_000;
      act(() =>
        seedBoard([
          boardCard("c1", {
            title: "Dark mode",
            columnId: "in_progress",
            lastRunStatus: "success",
            updatedAt: at,
            builder: {
              vendor: "claude",
              bypass: false,
              ptyId: "pty-1",
              sessionLost: false,
              startedAt: at - 12 * 60_000,
              snapshots: [{ n: 1, sha: "aaaaaaa1", at: at - 5 * 60_000 }],
              review: {
                snapshotN: 1,
                provider: "codex",
                degraded: false,
                status: "done",
                verdict: "changes_requested",
                at: reviewAt,
                findings: [{ severity: "P1", title: "A", body: "a", preExisting: false, pass: null }],
              },
            },
          }),
        ]),
      );
      // The Builder at work on the findings since 30 s ago, still printing.
      useBuilder.setState({
        byCard: {
          c1: { workspaceId: BOARD_WS, ptyId: "pty-1", vendor: "claude", startedAt: at - 12 * 60_000, pending: [], lastOutputAt: at + 10 * 60_000, promptBoxIdle: false } as never,
        },
        submittedAt: { c1: at - 30_000 },
        verdictDelivery: { c1: { at: reviewAt, ptyId: "pty-1", state: "sent", acked: true } },
      });
      act(() => useBoard.setState((s) => ({ view: { ...s.view, [BOARD_WS]: "list" } })));
      renderUi(<KanbanBoard workspaceId={BOARD_WS} />);
      const row = () => screen.getByRole("button", { name: /Dark mode/ }).closest("tr")!;
      expect(row().textContent).toContain("Claude is fixing 1 finding");
      expect(row().textContent).not.toContain(" · 1m");
      expect(row().textContent).toContain("Just now");
      act(() => {
        vi.advanceTimersByTime(2 * BOARD_LIST_TICK_MS + 1);
      });
      expect(row().textContent).toContain("Claude is fixing 1 finding · 1m");
      expect(row().textContent).toContain("1m ago");
    } finally {
      vi.useRealTimers();
      useBuilder.setState({ byCard: {}, submittedAt: {}, verdictDelivery: {} });
    }
  });
});

// A3 Challenger: a row that runs with no session open (the Challenger
// reviewing after the session closed) ticks too.
describe("the List's clock with no session open", () => {
  it("ticks while a listed card is being reviewed", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      const at = Date.now();
      act(() =>
        seedBoard([
          boardCard("c1", {
            title: "Dark mode",
            columnId: "in_progress",
            lastRunStatus: "success",
            updatedAt: at,
            builder: {
              vendor: "claude",
              bypass: false,
              ptyId: null,
              sessionLost: false,
              startedAt: at - 12 * 60_000,
              snapshots: [{ n: 1, sha: "abc", at: at - 5 * 60_000 } as never],
              review: { snapshotN: 1, provider: "codex", degraded: false, status: "running", at: at - 20_000 },
            } as never,
          }),
        ]),
      );
      useBuilder.setState({ byCard: {} });
      act(() => useBoard.setState((s) => ({ view: { ...s.view, [BOARD_WS]: "list" } })));
      renderUi(<KanbanBoard workspaceId={BOARD_WS} />);
      const row = () => screen.getByRole("button", { name: /Dark mode/ }).closest("tr")!;
      const before = row().textContent!;
      expect(before).toContain("Just now");
      act(() => {
        vi.advanceTimersByTime(2 * BOARD_LIST_TICK_MS + 1);
      });
      expect(row().textContent).toContain("1m ago");
      expect(row().textContent).not.toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the Board's List view", () => {
  it("shows the same cards as the columns, grouped by attention, and is remembered", async () => {
    seed();
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />);
    const onBoard = boardIds();
    await r.user.click(screen.getByRole("button", { name: "List" }));
    expect(useBoard.getState().view[BOARD_WS]).toBe("list");
    const table = screen.getByRole("table", { name: "Cards" });
    const groups = within(table)
      .getAllByRole("rowheader")
      .map((th) => th.textContent);
    expect(groups).toEqual(["Needs you · 2", "Not started · 1", "Working · 1", "Done · 1"]);
    const inList = within(table)
      .getAllByRole("checkbox")
      .map((box) => box.getAttribute("aria-label")!.replace(/^Select /, ""));
    expect(inList).toEqual([
      "Fix login redirect",
      "Void editor theme",
      "Write the brief",
      "Dark mode",
      "Toasts",
    ]);
    expect(onBoard).toEqual(["ship-a", "ship-b", "draft", "running", "shipped"]);
    const running = within(table).getByRole("button", { name: "Dark mode" }).closest("tr")!;
    expect(running.textContent).toContain("Codex");
    expect(running.textContent).toContain("Working");
    // 1.171.0 re-walk (step 4): a card with no session names the AI its
    // page shows (Settings' default here), never "None".
    const draft = within(table).getByRole("button", { name: "Write the brief" }).closest("tr")!;
    expect(draft.textContent).toContain("Claude");
    expect(draft.textContent).not.toContain("None");
    // Its own pick, as on its page.
    const before = useBuilder.getState().vendorPref;
    act(() => useBuilder.setState({ vendorPref: { ...before, draft: "codex" } }));
    try {
      expect(within(table).getByRole("button", { name: "Write the brief" }).closest("tr")!.textContent).toContain("Codex");
    } finally {
      act(() => useBuilder.setState({ vendorPref: before }));
    }
  });

  it("sorts within the groups", async () => {
    seed();
    act(() => useBoard.getState().setView(BOARD_WS, "list"));
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />);
    await r.user.click(screen.getByRole("button", { name: "Title" }));
    await r.user.click(screen.getByRole("button", { name: "Title" }));
    const titles = screen
      .getAllByRole("checkbox")
      .map((box) => box.getAttribute("aria-label")!.replace(/^Select /, ""));
    expect(titles.slice(0, 3)).toEqual([
      "Void editor theme",
      "Fix login redirect",
      "Write the brief",
    ]);
  });

  it("ships the selected verified cards through Ship batch", async () => {
    seed();
    act(() => useBoard.getState().setView(BOARD_WS, "list"));
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />);
    await r.user.click(screen.getByRole("checkbox", { name: "Select Fix login redirect" }));
    await r.user.click(screen.getByRole("checkbox", { name: "Select Write the brief" }));
    const bar = screen.getByRole("toolbar", { name: "Selected cards" });
    expect(bar.textContent).toContain("2 selected");
    // 1.171.0 E3 (owner D5): one card the batch takes is no batch.
    expect(within(bar).queryByRole("button", { name: /^Ship/ })).toBeNull();
    expect(bar.textContent).toContain(LIST_SHIP_ONE);
    await r.user.click(screen.getByRole("checkbox", { name: "Select Void editor theme" }));
    // GH #298: the bar takes the header row's place on the table's width,
    // and the action names its count.
    const table = screen.getByRole("table", { name: "Cards" });
    expect(bar.parentElement).toBe(table.parentElement);
    expect(table.querySelector("thead tr")?.className).toContain("ux-list-head--covered");
    expect(bar.closest(".board-list-bar, .cbtn--accent[disabled]")).toBeNull();
    // 1.174.0 (A4, owner): one filled button — Ship 2 while it shows, New
    // card bordered meanwhile (onePrimary's oneOf).
    const filled = () => [...document.querySelectorAll(".cbtn--accent")].map((b) => b.textContent?.trim());
    expect(filled()).toEqual(["Ship 2"]);
    expect(screen.getByRole("button", { name: /New card/ }).className).not.toContain("cbtn--accent");
    await r.user.click(within(bar).getByRole("button", { name: /^Ship 2$/ }));
    // 1.174.0 (DR3): the one Release sheet, with the selection ticked.
    expect(useUi.getState().releaseSheet?.workspaceId).toBe(BOARD_WS);
    expect([...(useUi.getState().releaseSheet?.cardIds ?? [])].sort()).toEqual(["ship-a", "ship-b"]);
    // With no selection it is as before: New card is the filled one.
    await r.user.click(within(screen.getByRole("toolbar", { name: "Selected cards" })).getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(filled()).toEqual(["New card"]));
  });

  // 1.171.0 E3 (owner D5): the batch is on every plan.
  it("offers Ship N on Free too", async () => {
    seed();
    act(() => {
      useBoard.getState().setView(BOARD_WS, "list");
      setPlanGates(FREE_GATES);
    });
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />);
    await r.user.click(screen.getByRole("checkbox", { name: "Select Fix login redirect" }));
    await r.user.click(screen.getByRole("checkbox", { name: "Select Void editor theme" }));
    const bar = screen.getByRole("toolbar", { name: "Selected cards" });
    expect(within(bar).getByRole("button", { name: /^Ship 2$/ }).textContent).not.toMatch(/\bPro\b/);
    act(() => setPlanGates(null));
  });

  // One ready card selected is no batch, on every plan: the bar says to
  // select two or more, and New card stays filled.
  it("on Free too, one ready card selected asks for two or more", async () => {
    seed();
    act(() => {
      useBoard.getState().setView(BOARD_WS, "list");
      setPlanGates(FREE_GATES);
    });
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />);
    await r.user.click(screen.getByRole("checkbox", { name: "Select Fix login redirect" }));
    const bar = screen.getByRole("toolbar", { name: "Selected cards" });
    expect(within(bar).queryByRole("button", { name: /^Ship|^Release/ })).toBeNull();
    expect(bar.textContent).toContain(LIST_SHIP_ONE);
    expect(screen.getByRole("button", { name: /New card/ }).className).toContain("cbtn--accent");
    act(() => setPlanGates(null));
  });

  // GH #298: with nothing ready among the selection there is no disabled
  // accent button, only a quiet sentence; Clear puts the header back.
  // SP-D: the sentence is about the batch — a card can be Ready to ship on
  // the Board and still not be one the batch takes.
  it("says none can ship in a batch instead of a disabled Ship, and Clear restores the header", async () => {
    seed();
    act(() => useBoard.getState().setView(BOARD_WS, "list"));
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />);
    await r.user.click(screen.getByRole("checkbox", { name: "Select Write the brief" }));
    const bar = screen.getByRole("toolbar", { name: "Selected cards" });
    expect(bar.textContent).toContain("None of these can be released with others yet");
    expect(bar.textContent).not.toMatch(/ready to ship/i);
    expect(within(bar).getByText("None of these can be released with others yet").title).toBe(SHIP_BATCH_RULE);
    expect(within(bar).queryByRole("button", { name: /^Ship/ })).toBeNull();
    expect(document.querySelector(".cbtn--accent:disabled")).toBeNull();
    await r.user.click(within(bar).getByRole("button", { name: "Clear" }));
    expect(screen.queryByRole("toolbar", { name: "Selected cards" })).toBeNull();
    expect(screen.getByRole("table", { name: "Cards" }).querySelector("thead tr")?.className).toBe("");
  });
});

// 1.171.0 walk fix (Blocks E+F, step 2): an approved Builder card whose
// session is still open. The note says why the batch leaves it out, in F1's
// words, on every plan.
describe("the List's note for a ready card with its session open", () => {
  // The open session's tip: nothing committed since the approved round.
  const TIP = { card_review_tip: { branchTip: "a", commitsSinceReview: 0 } };
  const sessionOpen = () =>
    boardCard("open", {
      title: "Notes: empty state",
      columnId: "in_progress",
      verifyStatus: "passed",
      shipStatus: "unshipped",
      worktreePath: "/wt",
      builder: {
        vendor: "codex",
        bypass: false,
        ptyId: "pty-1",
        sessionLost: false,
        startedAt: 1,
        snapshots: [{ n: 1, sha: "a", at: 1 }],
        review: { snapshotN: 1, provider: "claude", degraded: false, status: "done", verdict: "approve", reviewedRevision: "a", at: 1 },
      } as unknown as KanbanCard["builder"],
    });

  it("on Free too: none can ship in a batch, and why", async () => {
    act(() => {
      seedBoard([sessionOpen()]);
      useBoard.getState().setView(BOARD_WS, "list");
      setPlanGates(FREE_GATES);
    });
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />, { fixtures: TIP });
    await r.user.click(screen.getByRole("checkbox", { name: "Select Notes: empty state" }));
    const bar = screen.getByRole("toolbar", { name: "Selected cards" });
    expect(within(bar).getByText(`${LIST_NONE_IN_BATCH}. ${BATCH_SESSION_OPEN}`)).toBeTruthy();
    act(() => setPlanGates(null));
  });

  it("none can ship in a batch, and why — its session is open", async () => {
    act(() => {
      seedBoard([sessionOpen(), boardCard("draft", { title: "Write the brief" })]);
      useBoard.getState().setView(BOARD_WS, "list");
    });
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />, { fixtures: TIP });
    await r.user.click(screen.getByRole("checkbox", { name: "Select Notes: empty state" }));
    const bar = screen.getByRole("toolbar", { name: "Selected cards" });
    const note = within(bar).getByText(`${LIST_NONE_IN_BATCH}. ${BATCH_SESSION_OPEN}`);
    expect(note.title).toBe(BATCH_SESSION_OPEN);
    // A draft selected beside it changes nothing: it is the one left out.
    await r.user.click(screen.getByRole("checkbox", { name: "Select Write the brief" }));
    expect(within(bar).getByText(`${LIST_NONE_IN_BATCH}. ${BATCH_SESSION_OPEN}`)).toBeTruthy();
  });
});

// CL-9: the List grouped by stage, beside the attention grouping, and the
// choice remembered per workspace (workspaces.json, `listGrouping`).
describe("the List grouped by stage", () => {
  const groupHeadings = () =>
    within(screen.getByRole("table", { name: "Cards" }))
      .getAllByRole("rowheader")
      .map((th) => th.textContent);

  it("offers By attention and By stage only on the List, and regroups To do → Shipped", async () => {
    seed();
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />, {
      fixtures: { workspace_set_list_grouping: null },
    });
    // The Board is unchanged: no grouping control on the columns.
    expect(screen.queryByRole("group", { name: "Group the list" })).toBeNull();
    await r.user.click(screen.getByRole("button", { name: "List" }));
    const control = screen.getByRole("group", { name: "Group the list" });
    // Round 2: a visible, muted "Group by" before the buttons.
    expect(control.previousElementSibling?.textContent).toBe("Group by");
    expect(control.previousElementSibling?.className).toBe("board-group-by-label");
    expect(within(control).getAllByRole("button").map((b) => b.textContent)).toEqual([
      "By attention",
      "By stage",
    ]);
    expect(within(control).getByRole("button", { name: "By attention" }).getAttribute("aria-pressed")).toBe("true");
    expect(groupHeadings()).toEqual(["Needs you · 2", "Not started · 1", "Working · 1", "Done · 1"]);

    await r.user.click(within(control).getByRole("button", { name: "By stage" }));
    expect(r.tauri.callsOf("workspace_set_list_grouping")[0].args).toEqual({
      id: BOARD_WS,
      grouping: "stage",
    });
    expect(useWorkspaces.getState().workspaces[0].listGrouping).toBe("stage");
    expect(groupHeadings()).toEqual([
      "Ready to start · 1",
      "Working · 1",
      "Ready to ship · 2",
      "Done · 1",
    ]);
    // Every card is still on the List, and each row says its attention —
    // a card that needs the person is never hidden by its stage.
    const table = screen.getByRole("table", { name: "Cards" });
    expect(within(table).getAllByRole("checkbox")).toHaveLength(5);
    expect(within(table).getByRole("columnheader", { name: /Attention/ })).toBeTruthy();
    const draft = within(table).getByRole("button", { name: "Write the brief" }).closest("tr")!;
    // D13: a draft is Not started, with no alarm.
    expect(draft.textContent).toContain("Not started");
    expect(draft.querySelector(".ux-state-dot--aborted")).toBeNull();
    const running = within(table).getByRole("button", { name: "Dark mode" }).closest("tr")!;
    expect(running.textContent).toContain("Working");

    // Back to attention: the extra column goes.
    await r.user.click(within(control).getByRole("button", { name: "By attention" }));
    expect(r.tauri.callsOf("workspace_set_list_grouping")[1].args).toEqual({
      id: BOARD_WS,
      grouping: "attention",
    });
    expect(useWorkspaces.getState().workspaces[0].listGrouping).toBeNull();
    expect(groupHeadings()).toEqual(["Needs you · 2", "Not started · 1", "Working · 1", "Done · 1"]);
    expect(within(screen.getByRole("table", { name: "Cards" })).queryByRole("columnheader", { name: "Attention" })).toBeNull();
  });

  // Round 2 (F1): a column sort keeps Needs you first within each stage;
  // the Attention column sorts too.
  it("keeps what needs the person first when a column is sorted, and sorts by Attention", async () => {
    act(() =>
      seedBoard(
        [
          boardCard("w", {
            title: "Alpha running",
            columnId: "in_progress",
            lastRunStatus: "running",
            builder: { vendor: "claude", bypass: false, ptyId: "pty-1", sessionLost: false, startedAt: 1, snapshots: [] },
          }),
          boardCard("f", {
            title: "Mike stopped",
            columnId: "in_progress",
            lastRunStatus: "failed",
          }),
        ],
        { listGrouping: "stage" },
      ),
    );
    act(() => useBoard.getState().setView(BOARD_WS, "list"));
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />);
    const titles = () =>
      screen.getAllByRole("checkbox").map((box) => box.getAttribute("aria-label")!.replace(/^Select /, ""));
    expect(groupHeadings()).toEqual(["Working · 2"]);
    await r.user.click(screen.getByRole("button", { name: "Title" }));
    expect(titles().slice(0, 2)).toEqual(["Mike stopped", "Alpha running"]);
    await r.user.click(screen.getByRole("button", { name: "Attention" }));
    await r.user.click(screen.getByRole("button", { name: "Attention" }));
    expect(titles().slice(0, 2)).toEqual(["Alpha running", "Mike stopped"]);
  });

  it("is remembered per workspace", () => {
    seed();
    const other = "ws-2";
    act(() => {
      useWorkspaces.setState({
        workspaces: [
          boardWorkspace,
          { ...boardWorkspace, id: other, name: "Vega", listGrouping: "stage" },
        ],
        activeId: BOARD_WS,
      });
      useKanban.setState((s) => ({
        byWorkspace: {
          ...s.byWorkspace,
          [other]: {
            cards: [boardCard("o1", { workspaceId: other, title: "Other draft" })],
            loaded: true,
          },
        },
      }));
      useBoard.getState().setView(BOARD_WS, "list");
      useBoard.getState().setView(other, "list");
    });
    const first = renderUi(<KanbanBoard workspaceId={BOARD_WS} />);
    expect(groupHeadings()).toEqual(["Needs you · 2", "Not started · 1", "Working · 1", "Done · 1"]);
    first.unmount();
    renderUi(<KanbanBoard workspaceId={other} />);
    expect(groupHeadings()).toEqual(["Ready to start · 1"]);
    expect(
      screen.getByRole("button", { name: "By stage" }).getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("reads a grouping it does not know as attention, and puts the choice back when the save is refused", async () => {
    seed();
    act(() => {
      useWorkspaces.setState((s) => ({
        workspaces: s.workspaces.map((w) => ({ ...w, listGrouping: "byPhaseFromLater" })),
      }));
      useBoard.getState().setView(BOARD_WS, "list");
    });
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />, {
      fixtures: {
        workspace_set_list_grouping: () => Promise.reject(new Error("disk full")),
      },
      withToasts: true,
    });
    expect(groupHeadings()).toEqual(["Needs you · 2", "Not started · 1", "Working · 1", "Done · 1"]);
    await r.user.click(screen.getByRole("button", { name: "By stage" }));
    expect(await screen.findByText("Grouping not saved.")).toBeTruthy();
    expect(useWorkspaces.getState().workspaces[0].listGrouping).toBe("byPhaseFromLater");
    expect(groupHeadings()).toEqual(["Needs you · 2", "Not started · 1", "Working · 1", "Done · 1"]);
  });
});
