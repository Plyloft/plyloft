// QoL 1.168 (block 10, C6): the Board by keyboard — ↑/↓ (J/K) and ←/→ move the
// focus between cards, ⌥↑/⌥↓ reorder a card (the drag's write and Undo),
// ⌥←/⌥→ are answered as a drag to that column is (refused: a card's column
// follows its work), and the card's menu (right-click, Shift+F10) offers
// Open, the moves, Archive and Delete.
import { describe, expect, it } from "vitest";
import { KanbanBoard } from "../components/KanbanBoard";
import { latestToast, useToasts } from "../store/toastStore";
import { useUi } from "../store/uiStore";
import { useWorkspaces } from "../store/workspaceStore";
import { useLicense } from "../store/licenseStore";
import { TEAM_BOARD_READ_ONLY_MESSAGE } from "../lib/teamGateCardWrites";
import { BOARD_COLUMN_FOLLOWS_STATE_COPY } from "../lib/boardSemantics";
import { act, fireEvent, renderUi, screen, tauri, waitFor, within } from "./render";
import { boardCard, seedBoard, BOARD_WS } from "./boardFixtures";

const card = (title: string) => screen.getByRole("button", { name: new RegExp(`^${title}`) });
const column = (name: string) => screen.getByRole("region", { name: new RegExp(`^${name}`) });
const order = () =>
  Array.from(column("Not started").querySelectorAll("[data-board-card-id]")).map((el) =>
    el.getAttribute("data-board-card-id"),
  );

function seed() {
  act(() =>
    seedBoard([
      boardCard("first", { title: "First", createdAt: 100 }),
      boardCard("second", { title: "Second", createdAt: 200 }),
      boardCard("third", { title: "Third", createdAt: 300 }),
      boardCard("fourth", { title: "Fourth thing", createdAt: 400 }),
      boardCard("running", { title: "Running", columnId: "in_progress", lastRunStatus: "running" }),
    ]),
  );
  tauri().fixture("kanban_card_set_board_order", (args: Record<string, unknown>) => ({
    ...boardCard(String(args.cardId)),
    title: args.cardId === "third" ? "Third" : String(args.cardId),
    boardOrder: args.boardOrder,
  }));
}

describe("the Board by keyboard", () => {
  it("moves the focus between cards and columns, and Enter opens", async () => {
    seed();
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />);
    card("First").focus();
    fireEvent.keyDown(card("First"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(card("Second"));
    fireEvent.keyDown(card("Second"), { key: "j" });
    expect(document.activeElement).toBe(card("Third"));
    fireEvent.keyDown(card("Third"), { key: "k" });
    expect(document.activeElement).toBe(card("Second"));
    // → lands on the next column's card (Working has one).
    fireEvent.keyDown(card("Second"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(card("Running"));
    fireEvent.keyDown(card("Running"), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(card("First"));
    await r.user.keyboard("{Enter}");
    expect(useUi.getState().selectedCardId[BOARD_WS]).toBe("first");
  });

  it("⌥↑ reorders with the drag's one write; ⌥→ says why the card stays", async () => {
    seed();
    renderUi(<KanbanBoard workspaceId={BOARD_WS} />);
    card("Third").focus();
    await act(async () => {
      fireEvent.keyDown(card("Third"), { key: "ArrowUp", altKey: true });
    });
    await waitFor(() => expect(tauri().callsOf("kanban_card_set_board_order")).toHaveLength(1));
    expect(tauri().callsOf("kanban_card_set_board_order")[0].args.cardId).toBe("third");
    await waitFor(() => expect(order()).toEqual(["first", "third", "second", "fourth"]));
    expect(useToasts.getState().toasts.some((t) => t.title === "Card moved")).toBe(true);

    tauri().fixture("project_folder_check", null);
    await act(async () => {
      fireEvent.keyDown(card("First"), { key: "ArrowRight", altKey: true });
    });
    await waitFor(() => expect(latestToast()?.body).toBe(BOARD_COLUMN_FOLLOWS_STATE_COPY));
    expect(tauri().callsOf("kanban_card_set_board_order")).toHaveLength(1);
    expect(tauri().callsOf("kanban_card_patch")).toHaveLength(0);
  });

  it("a held ⌥→ says its refusal once", async () => {
    seed();
    renderUi(<KanbanBoard workspaceId={BOARD_WS} />);
    tauri().fixture("project_folder_check", null);
    card("First").focus();
    await act(async () => {
      fireEvent.keyDown(card("First"), { key: "ArrowRight", altKey: true });
      for (let i = 0; i < 5; i += 1) fireEvent.keyDown(card("First"), { key: "ArrowRight", altKey: true, repeat: true });
    });
    await waitFor(() => expect(tauri().callsOf("project_folder_check")).toHaveLength(1));
    await waitFor(() => expect(latestToast()?.body).toBe(BOARD_COLUMN_FOLLOWS_STATE_COPY));
    const said = [...useToasts.getState().toasts, ...useToasts.getState().queue].filter((t) => t.title === "Card not moved");
    expect(said).toHaveLength(1);
    expect(useToasts.getState().recent[0]?.times ?? 1).toBe(1);
  });

  it("a refused ⌥→ leaves the keyboard on the card somebody went to during the folder check", async () => {
    seed();
    renderUi(<KanbanBoard workspaceId={BOARD_WS} />);
    let answer: (v: null) => void = () => {};
    tauri().fixture("project_folder_check", () => new Promise<null>((resolve) => (answer = resolve)));
    card("First").focus();
    await act(async () => {
      fireEvent.keyDown(card("First"), { key: "ArrowRight", altKey: true });
    });
    await waitFor(() => expect(tauri().callsOf("project_folder_check")).toHaveLength(1));
    card("Third").focus();
    await act(async () => {
      answer(null);
      await new Promise((r) => requestAnimationFrame(r));
    });
    await waitFor(() => expect(latestToast()?.body).toBe(BOARD_COLUMN_FOLLOWS_STATE_COPY));
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(r));
    });
    expect(document.activeElement).toBe(card("Third"));
  });

  it("the card's menu has Open, the moves, Archive and Delete — a refused move says why", async () => {
    seed();
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />);
    card("Second").focus();
    fireEvent.keyDown(card("Second"), { key: "F10", shiftKey: true });
    const menu = await screen.findByRole("menu", { name: "Card: Second" });
    const names = within(menu)
      .getAllByRole("menuitem")
      .map((b) => b.textContent?.replace(/⌥.$/, "") ?? "");
    expect(names[0]).toBe("Open");
    expect(names.some((n) => n.startsWith("Move up"))).toBe(true);
    expect(names.some((n) => n.startsWith("Move to Working"))).toBe(true);
    expect(names.some((n) => n.startsWith("Archive"))).toBe(true);
    expect(names.some((n) => n.startsWith("Delete card…"))).toBe(true);
    const toWorking = within(menu).getByRole("menuitem", { name: /^Move to Working/ }) as HTMLButtonElement;
    expect(toWorking.disabled).toBe(true);
    // Block 10 Mac walk: each refused move says why.
    // Block 8 (D13): "Second" is a draft, so it sits in Not started and is
    // offered every other column — Needs you and On hold among them.
    expect(names.some((n) => n.startsWith("Move to Not started"))).toBe(false);
    for (const name of [/^Move to Needs you/, /^Move to Working/, /^Move to On hold/, /^Move to Done/]) {
      const item = within(menu).getByRole("menuitem", { name });
      expect(item.getAttribute("aria-describedby")).toBeTruthy();
      expect(item.textContent!.length).toBeGreaterThan(20);
    }
    expect(within(menu).getByRole("menuitem", { name: /^Archive/ })).toHaveProperty("disabled", false);
    // Move down, from the menu: the same write as ⌥↓.
    await r.user.click(within(menu).getByRole("menuitem", { name: /^Move down/ }));
    await waitFor(() => expect(order()).toEqual(["first", "third", "second", "fourth"]));
    expect(screen.queryByRole("menu", { name: "Card: Second" })).toBeNull();
  });

  it("a running card cannot be archived from its menu, and says why", async () => {
    seed();
    renderUi(<KanbanBoard workspaceId={BOARD_WS} />);
    fireEvent.contextMenu(card("Running"));
    const menu = await screen.findByRole("menu", { name: "Card: Running" });
    const archive = within(menu).getByRole("menuitem", { name: /^Archive/ }) as HTMLButtonElement;
    expect(archive.disabled).toBe(true);
    expect(archive.textContent).toContain("Stop or finish this work before archiving the card.");
  });

  // Challenger item 7: under a search, ⌥↑ goes past the card shown above,
  // not a hidden one.
  it("⌥↑ under a search moves past the shown card above", async () => {
    seed();
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />);
    await r.user.type(screen.getByRole("searchbox", { name: /Find a card/ }), "o");
    // "Second" and "Fourth thing" are shown; "First" and "Third" are not.
    expect(order()).toEqual(["second", "fourth"]);
    card("Fourth thing").focus();
    await act(async () => {
      fireEvent.keyDown(card("Fourth thing"), { key: "ArrowUp", altKey: true });
    });
    await waitFor(() => expect(tauri().callsOf("kanban_card_set_board_order")).toHaveLength(1));
    const { cardId, boardOrder } = tauri().callsOf("kanban_card_set_board_order")[0].args as { cardId: string; boardOrder: number };
    expect(cardId).toBe("fourth");
    // Above Second (between First and Second), not just above the hidden Third.
    expect(boardOrder).toBeGreaterThan(100);
    expect(boardOrder).toBeLessThan(200);
  });

  it("archive from the menu by keyboard hands the focus to the card beside it", async () => {
    seed();
    tauri().fixture("kanban_card_archive", (args: Record<string, unknown>) => ({
      ...boardCard(String(args.cardId)),
      archived: true,
    }));
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />, { withToasts: true });
    card("Second").focus();
    fireEvent.keyDown(card("Second"), { key: "F10", shiftKey: true });
    const menu = await screen.findByRole("menu", { name: "Card: Second" });
    within(menu).getByRole("menuitem", { name: /^Archive/ }).focus();
    await r.user.keyboard("{Enter}");
    await waitFor(() => expect(order()).toEqual(["first", "third", "fourth"]));
    await waitFor(() => expect(document.activeElement).toBe(card("Third")));
  });

  it("moves nothing on a read-only team Board, and says why", async () => {
    seed();
    act(() => {
      useWorkspaces.setState((s) => ({
        workspaces: s.workspaces.map((w) =>
          w.id === BOARD_WS ? { ...w, kanbanSyncMode: "githubIssues" as const } : w,
        ),
      }));
      useLicense.setState({ info: null });
    });
    renderUi(<KanbanBoard workspaceId={BOARD_WS} />);
    card("Third").focus();
    await act(async () => {
      fireEvent.keyDown(card("Third"), { key: "ArrowUp", altKey: true });
    });
    expect(latestToast()?.body).toBe(TEAM_BOARD_READ_ONLY_MESSAGE);
    expect(tauri().callsOf("kanban_card_set_board_order")).toHaveLength(0);
    fireEvent.contextMenu(card("Third"));
    const menu = await screen.findByRole("menu", { name: "Card: Third" });
    for (const name of [/^Move up/, /^Move down/, /^Archive/]) {
      expect((within(menu).getByRole("menuitem", { name }) as HTMLButtonElement).disabled).toBe(true);
    }
  });
});
