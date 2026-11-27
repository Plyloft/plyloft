// UX-5.3: a drag on the Board reorders within the card's column and
// archives — it never starts, stops or ships work, and never writes the
// persisted column.
import { describe, expect, it, vi } from "vitest";
import { UNDO_WINDOW_MS } from "../store/boardStore";
import { KanbanBoard } from "../components/KanbanBoard";
import { latestToast, useToasts } from "../store/toastStore";
import { ATELIER_CARD_TYPE } from "../lib/dropGuard";
import { act, fireEvent, renderUi, screen, tauri, waitFor } from "./render";
import { boardCard, seedBoard, BOARD_WS } from "./boardFixtures";

/** What a card drag carries, as WKWebView hands it to `drop`. */
function carrying(cardId: string) {
  return {
    dataTransfer: {
      types: [ATELIER_CARD_TYPE, "text/plain"],
      getData: (type: string) =>
        type === ATELIER_CARD_TYPE || type === "text/plain" ? cardId : "",
      dropEffect: "move",
    },
  };
}

/** A drag's start: the card's handler writes its id into the drag. */
function starting(cardId: string) {
  const c = carrying(cardId);
  return { dataTransfer: { ...c.dataTransfer, setData: () => {}, effectAllowed: "move" } };
}

const column = (name: string) =>
  screen.getByRole("region", { name: new RegExp(`^${name}`) });

/** Every command that could start, stop, ship or re-column a card. */
const LIFECYCLE = [
  "kanban_card_advance_to_in_progress",
  "kanban_card_patch",
  "kanban_card_set_run_state",
  "card_ship",
  "ship_batch",
  "builder_start",
  "agent_run_start",
  "swarm_start",
];

function seed() {
  act(() =>
    seedBoard([
      boardCard("first", { title: "First", createdAt: 100 }),
      boardCard("second", { title: "Second", createdAt: 200 }),
      boardCard("third", { title: "Third", createdAt: 300 }),
      boardCard("running", {
        title: "Running",
        columnId: "in_progress",
        lastRunStatus: "running",
      }),
    ]),
  );
  tauri().fixture("kanban_card_set_board_order", (args: Record<string, unknown>) => ({
    ...boardCard(String(args.cardId), { createdAt: 300 }),
    title: "Third",
    boardOrder: args.boardOrder,
  }));
  tauri().fixture("kanban_card_archive", (args: Record<string, unknown>) => ({
    ...boardCard(String(args.cardId)),
    archived: true,
  }));
}

describe("dragging a card on the Board", () => {
  it("reorders within its column and writes only the order", async () => {
    seed();
    renderUi(<KanbanBoard workspaceId={BOARD_WS} />);
    // Released on "First" (after it, in a layout-free jsdom): between First
    // and Second.
    const first = column("Not started").querySelector('[data-board-card-id="first"]')!;
    await act(async () => {
      fireEvent.drop(first, carrying("third"));
    });
    const [call] = tauri().callsOf("kanban_card_set_board_order");
    expect(call.args).toEqual({ workspaceId: BOARD_WS, cardId: "third", boardOrder: 150 });
    const order = Array.from(
      column("Not started").querySelectorAll("[data-board-card-id]"),
    ).map((el) => el.getAttribute("data-board-card-id"));
    expect(order).toEqual(["first", "third", "second"]);
    for (const cmd of LIFECYCLE) expect(tauri().callsOf(cmd)).toHaveLength(0);
  });

  it("refuses a drop on another column instead of starting the card", async () => {
    seed();
    renderUi(<KanbanBoard workspaceId={BOARD_WS} />);
    tauri().fixture("project_folder_check", null);
    await act(async () => {
      fireEvent.drop(column("Working"), carrying("first"));
    });
    await waitFor(() => expect(useToasts.getState().toasts).toHaveLength(1));
    expect(tauri().calls.filter((c) => c.cmd.startsWith("kanban_card"))).toEqual([]);
    for (const cmd of LIFECYCLE) expect(tauri().callsOf(cmd)).toHaveLength(0);
    expect(useToasts.getState().toasts.map((t) => t.body)).toEqual([
      "A card changes column as its work moves. Open it to start, stop or ship.",
    ]);
  });

  it("U32: with the project's folder gone, a refused move gives the same cause as Start build", async () => {
    seed();
    renderUi(<KanbanBoard workspaceId={BOARD_WS} />);
    tauri().fixture("project_folder_check", () => "This project's folder isn't where Plyloft left it, so nothing was claimed.");
    await act(async () => {
      fireEvent.drop(column("Working"), carrying("first"));
    });
    await waitFor(() => expect(useToasts.getState().toasts).toHaveLength(1));
    const [toast] = useToasts.getState().toasts;
    expect(toast.title).toBe("Card not moved");
    expect(toast.body).toBe(
      "This project's folder isn't where Plyloft left it, so nothing was claimed. Put the folder back; a team's project can be cloned again from Settings › Team › Members and library.",
    );
    expect(tauri().calls.filter((c) => c.cmd.startsWith("kanban_card"))).toEqual([]);
    for (const cmd of LIFECYCLE) expect(tauri().callsOf(cmd)).toHaveLength(0);
  });

  it("on a local board, the same refusal names no claim", async () => {
    seed();
    renderUi(<KanbanBoard workspaceId={BOARD_WS} />);
    tauri().fixture(
      "project_folder_check",
      () => "This project's folder isn't where Plyloft left it. Put the folder back; a team's project can be cloned again from Settings › Team › Members and library.",
    );
    await act(async () => {
      fireEvent.drop(column("Working"), carrying("first"));
    });
    await waitFor(() => expect(useToasts.getState().toasts).toHaveLength(1));
    expect(useToasts.getState().toasts[0].body).toBe(
      "This project's folder isn't where Plyloft left it. Put the folder back; a team's project can be cloned again from Settings › Team › Members and library.",
    );
  });

  it("U32: a refusal that isn't a start doesn't ask about the folder", async () => {
    seed();
    renderUi(<KanbanBoard workspaceId={BOARD_WS} />);
    await act(async () => {
      fireEvent.drop(column("Done"), carrying("first"));
    });
    await waitFor(() => expect(useToasts.getState().toasts).toHaveLength(1));
    expect(tauri().callsOf("project_folder_check")).toHaveLength(0);
  });

  // 1.173.0 (F1, BI-16): while a card is dragged only the zones it may land
  // in light up — its own column and the Archived row; the others stay dark
  // and still refuse a drop with their toast.
  it("lights only the columns the dragged card may go to", async () => {
    seed();
    renderUi(<KanbanBoard workspaceId={BOARD_WS} />);
    const first = column("Not started").querySelector('[data-board-card-id="first"]')!;
    await act(async () => {
      fireEvent.dragStart(first, starting("first"));
      // The Archived row shows once a card drag is on the page.
      fireEvent.dragEnter(document.body, carrying("first"));
    });
    const lit = () => Array.from(document.querySelectorAll(".board-drop-target")).map((el) => el.getAttribute("data-board-column") ?? "archive");
    for (const [zone, expected] of [
      [column("Working"), []],
      [column("Done"), []],
      [column("Needs you"), []],
      [column("Not started"), ["not-started"]],
    ] as const) {
      await act(async () => {
        fireEvent.dragOver(zone, carrying("first"));
      });
      expect(lit()).toEqual(expected);
    }
    await act(async () => {
      fireEvent.dragOver(document.querySelector("[data-board-archive]")!, carrying("first"));
    });
    expect(lit()).toEqual(["archive"]);
    // A running card may not be archived: the Archived row stays dark.
    await act(async () => {
      fireEvent.dragEnd(first);
    });
    await act(async () => {
      fireEvent.dragStart(column("Working").querySelector('[data-board-card-id="running"]')!, starting("running"));
      fireEvent.dragEnter(document.body, carrying("running"));
    });
    await act(async () => {
      fireEvent.dragOver(document.querySelector("[data-board-archive]")!, carrying("running"));
    });
    expect(lit()).toEqual([]);
    await act(async () => {
      fireEvent.dragOver(column("Working"), carrying("running"));
    });
    expect(lit()).toEqual(["working"]);
    // An illegal drop is still refused, with the toast.
    await act(async () => {
      fireEvent.drop(column("Done"), carrying("running"));
    });
    expect(latestToast()?.title).toBe("Card not moved");
    expect(lit()).toEqual([]);
  });

  // QoL 1.168 S1-3: Done fills when a card ships — a drop there archives
  // nothing; the Archived row (shown while a card is dragged) archives.
  it("refuses a drop on Done, and archives on the Archived row — never a running card", async () => {
    seed();
    renderUi(<KanbanBoard workspaceId={BOARD_WS} />, { fakeTimers: true });
    await act(async () => {
      fireEvent.drop(column("Done"), carrying("second"));
    });
    expect(tauri().callsOf("kanban_card_archive")).toHaveLength(0);
    expect(latestToast()?.body).toBe(
      "Done fills when a card ships. Finish it first, then ship it.",
    );
    expect(column("Not started").querySelector('[data-board-card-id="second"]')).not.toBeNull();
    await act(async () => {
      fireEvent.dragEnter(document.body, carrying("running"));
    });
    const archive = document.querySelector("[data-board-archive]")!;
    expect(archive.textContent).toContain("Drop here to archive");
    await act(async () => {
      fireEvent.drop(archive, carrying("running"));
    });
    expect(tauri().callsOf("kanban_card_archive")).toHaveLength(0);
    expect(latestToast()?.body).toBe(
      "Stop or finish this work before archiving the card.",
    );
    await act(async () => {
      fireEvent.dragEnter(document.body, carrying("second"));
    });
    await act(async () => {
      fireEvent.drop(document.querySelector("[data-board-archive]")!, carrying("second"));
    });
    // Archived when its Undo window ends (UX-5.9, boardUndo.test.tsx).
    expect(column("Not started").querySelector('[data-board-card-id="second"]')).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(UNDO_WINDOW_MS);
    });
    await waitFor(() =>
      expect(tauri().callsOf("kanban_card_archive").map((c) => c.args.cardId)).toEqual([
        "second",
      ]),
    );
    for (const cmd of LIFECYCLE) expect(tauri().callsOf(cmd)).toHaveLength(0);
  });
});
