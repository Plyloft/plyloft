// UX-5.8: Done shows the latest ten with "Show all N"; a card shipped more
// than 14 days ago is archived on its own and can be restored — never on a
// read-only Board.
import { describe, expect, it } from "vitest";
import { KanbanBoard } from "../components/KanbanBoard";
import type { KanbanCard } from "../ipc";
import { useKanban } from "../store/kanbanStore";
import { act, renderUi, screen, tauri, waitFor, within } from "./render";
import { boardCard, seedBoard, BOARD_WS } from "./boardFixtures";

const DAY = 24 * 60 * 60 * 1000;

const shipped = (id: string, daysAgo: number, patch: Partial<KanbanCard> = {}) =>
  boardCard(id, {
    title: `Shipped ${id}`,
    columnId: "complete",
    shipStatus: "shipped",
    shipHistory: [
      {
        commitSha: "abc",
        shippedVersion: "v1",
        releaseKind: "local",
        shippedAt: Date.now() - daysAgo * DAY,
      },
    ],
    ...patch,
  });

const doneIds = () =>
  Array.from(
    screen
      .getByRole("region", { name: /^Done/ })
      .querySelectorAll("[data-board-card-id]"),
  ).map((el) => el.getAttribute("data-board-card-id"));

describe("Done and the archive", () => {
  it("shows the latest ten, then all on Show all N", async () => {
    const cards = Array.from({ length: 12 }, (_, i) => shipped(`d${i}`, i / 10));
    act(() => seedBoard(cards));
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />);
    expect(doneIds()).toEqual(cards.slice(0, 10).map((c) => c.id));
    expect(screen.getByRole("region", { name: /^Done/ }).querySelector("h2")!.textContent).toBe(
      "Done12",
    );
    await r.user.click(screen.getByRole("button", { name: "Show all 12" }));
    expect(doneIds()).toHaveLength(12);
    await r.user.click(screen.getByRole("button", { name: "Show the latest 10" }));
    expect(doneIds()).toHaveLength(10);
  });

  it("says on the List how many of Done's cards it shows (P-D2 Mac walk)", async () => {
    // The walk read "Done · 10" on the List beside "Done 12" on the Board.
    const cards = Array.from({ length: 12 }, (_, i) => shipped(`d${i}`, i / 10));
    act(() => seedBoard(cards));
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />, {
      fixtures: { workspace_set_list_grouping: null },
    });
    await r.user.click(screen.getByRole("button", { name: "List" }));
    const headings = () =>
      within(screen.getByRole("table", { name: "Cards" }))
        .getAllByRole("rowheader")
        .map((th) => th.textContent);
    expect(headings()).toEqual(["Done · 10 of 12"]);
    await r.user.click(screen.getByRole("button", { name: "By stage" }));
    expect(headings()).toEqual(["Done · 10 of 12"]);
    await r.user.click(screen.getByRole("button", { name: "Show all 12" }));
    expect(headings()).toEqual(["Done · 12"]);
    await r.user.click(screen.getByRole("button", { name: "By attention" }));
    expect(headings()).toEqual(["Done · 12"]);
  });

  it("archives a card shipped more than 14 days ago, and Restore brings it back", async () => {
    act(() => seedBoard([shipped("old", 15), shipped("recent", 3), shipped("kept", 30, { archivedAt: 1 })]));
    tauri().fixture("kanban_card_archive", (args: Record<string, unknown>) => ({
      ...shipped(String(args.cardId), 15),
      archived: true,
      autoArchived: args.auto === true,
      archivedAt: Date.now(),
    }));
    tauri().fixture("kanban_card_restore", (args: Record<string, unknown>) => ({
      ...shipped(String(args.cardId), 15),
      archivedAt: Date.now(),
    }));
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />);
    await waitFor(() => expect(tauri().callsOf("kanban_card_archive")).toHaveLength(1));
    expect(tauri().callsOf("kanban_card_archive")[0].args).toEqual({
      workspaceId: BOARD_WS,
      cardId: "old",
      auto: true,
    });
    await waitFor(() => expect(doneIds()).toEqual(["recent", "kept"]));
    await r.user.click(screen.getByRole("button", { name: /^Archived/ }));
    await r.user.click(screen.getByRole("button", { name: "Restore" }));
    expect(tauri().callsOf("kanban_card_restore")[0].args).toEqual({
      workspaceId: BOARD_WS,
      cardId: "old",
    });
    await waitFor(() => expect(doneIds()).toContain("old"));
    // Brought back, it is not taken again.
    expect(tauri().callsOf("kanban_card_archive")).toHaveLength(1);
    expect(useKanban.getState().byWorkspace[BOARD_WS].cards.find((c) => c.id === "old")?.archivedAt).toBeTruthy();
  });

  it("leaves a read-only GitHub Board as it is", () => {
    act(() => seedBoard([shipped("ro-old", 40)], { kanbanSyncMode: "githubIssues" }));
    renderUi(<KanbanBoard workspaceId={BOARD_WS} />);
    expect(tauri().callsOf("kanban_card_archive")).toHaveLength(0);
    expect(doneIds()).toEqual(["ro-old"]);
  });
});
