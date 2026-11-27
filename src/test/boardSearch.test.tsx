// UX-5.7: "Find a card" (title, notes, issue number) and the filters
// (Needs you, state, Builder) combine, narrow the columns and the List the
// same way, and `/` or ⌘F puts the caret in the search on the Board.
import { describe, expect, it } from "vitest";
import { KanbanBoard } from "../components/KanbanBoard";
import { useBoard } from "../store/boardStore";
import { useUi } from "../store/uiStore";
import { act, fireEvent, renderUi, screen, within } from "./render";
import { boardCard, seedBoard, BOARD_WS } from "./boardFixtures";

const codex = { vendor: "codex" as const, bypass: false, sessionLost: false, startedAt: 1, snapshots: [] };

function seed() {
  act(() => {
    seedBoard([
      boardCard("login", { title: "Fix login redirect", notes: "Cookie path is wrong" }),
      boardCard("search", { title: "Rate-limit the search endpoint", ghIssueNumber: 42 }),
      boardCard("failed", {
        title: "Export as CSV",
        columnId: "in_progress",
        lastRunStatus: "failed",
        builder: codex,
      }),
      boardCard("running", {
        title: "Dark mode",
        columnId: "in_progress",
        lastRunStatus: "running",
        // GH #244: a running build has its session open.
        builder: { ...codex, ptyId: "pty-1" },
      }),
    ]);
    useUi.getState().setCenterMode(BOARD_WS, "board");
  });
}

const shown = () =>
  Array.from(document.querySelectorAll("[data-board-card-id]")).map((el) =>
    el.getAttribute("data-board-card-id"),
  );
const status = () => document.querySelector("[data-board-filter-status]")!.textContent;

describe("finding cards on the Board", () => {
  it("searches titles, notes and issue numbers", async () => {
    seed();
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />);
    const field = screen.getByRole("searchbox", { name: /Find a card/ });
    await r.user.type(field, "cookie");
    expect(shown()).toEqual(["login"]);
    expect(status()).toBe("Showing 1 of 4 cards");
    await r.user.clear(field);
    await r.user.type(field, "#42");
    expect(shown()).toEqual(["search"]);
    await r.user.clear(field);
    await r.user.type(field, "nothing like it");
    expect(shown()).toEqual([]);
    expect(screen.getByText("No card matches the search and filters.")).toBeTruthy();
    await r.user.click(screen.getByRole("button", { name: "Clear search and filters" }));
    expect(shown()).toHaveLength(4);
    expect(status()).toBe("Showing all 4 cards");
  });

  it("combines Needs you with the state and Builder filters, the same on the List", async () => {
    seed();
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />);
    await r.user.click(screen.getByRole("button", { name: "Filter" }));
    const menu = screen.getByRole("dialog", { name: "Filter the cards" });
    await r.user.click(within(menu).getByRole("checkbox", { name: /Needs you only/ }));
    // QoL 1.168 block 8 (D13): drafts are Not started, never Needs you.
    expect(shown()).toEqual(["failed"]);
    await r.user.click(within(menu).getByRole("checkbox", { name: "Codex" }));
    expect(shown()).toEqual(["failed"]);
    expect(screen.getByRole("button", { name: "Filter, 2 on" })).toBeTruthy();
    // The List draws the same cards.
    await r.user.click(screen.getByRole("button", { name: "List" }));
    const table = screen.getByRole("table", { name: "Cards" });
    expect(
      within(table)
        .getAllByRole("checkbox")
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual(["Select Export as CSV"]);
    act(() => useBoard.getState().clearFilter(BOARD_WS));
    expect(within(screen.getByRole("table", { name: "Cards" })).getAllByRole("checkbox")).toHaveLength(4);
  });

  it("filters by state", async () => {
    seed();
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />);
    await r.user.click(screen.getByRole("button", { name: "Filter" }));
    const menu = screen.getByRole("dialog", { name: "Filter the cards" });
    const states = within(menu)
      .getAllByRole("checkbox")
      .map((b) => b.closest("label")!.textContent);
    expect(states).toContain("Working");
    await r.user.click(within(menu).getByRole("checkbox", { name: "Working" }));
    expect(shown()).toEqual(["running"]);
  });

  it("puts the caret in the search on / and ⌘F, not while typing elsewhere", () => {
    seed();
    renderUi(<KanbanBoard workspaceId={BOARD_WS} />);
    const field = screen.getByRole("searchbox", { name: /Find a card/ });
    fireEvent.keyDown(window, { key: "/" });
    expect(document.activeElement).toBe(field);
    field.blur();
    fireEvent.keyDown(window, { key: "f", metaKey: true });
    expect(document.activeElement).toBe(field);
    field.blur();
    // A card open over the Board keeps its keys.
    act(() => useUi.getState().selectCard(BOARD_WS, "login"));
    fireEvent.keyDown(window, { key: "/" });
    expect(document.activeElement).not.toBe(field);
  });
});
