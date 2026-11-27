// C7 (UX-7.2, 7.3) on the Board: a card held by a blocker that has not
// shipped sits in On hold and says "Blocked by #n" with the blockedBy icon —
// on the columns and in the List's Status. When the blocker ships it is back
// in Not started, "Ready to start", and nothing was started for it.
import { describe, expect, it } from "vitest";
import { KanbanBoard } from "../components/KanbanBoard";
import { useKanban } from "../store/kanbanStore";
import { act, renderUi, screen, within } from "./render";
import { BOARD_WS, boardCard, seedBoard } from "./boardFixtures";

const column = (name: string) => screen.getByRole("region", { name: new RegExp(`^${name}`) });
const ids = (name: string) =>
  Array.from(column(name).querySelectorAll("[data-ply-board-card-id]")).map((el) =>
    el.getAttribute("data-ply-board-card-id"),
  );

describe("a card waiting for another", () => {
  it("waits, says what for, and lands in Not started when its blocker ships — started by no one", async () => {
    const cookie = boardCard("cookie", { title: "Session cookie expiry", ghIssueNumber: 41, columnId: "in_progress", lastRunStatus: "running" });
    const login = boardCard("login", { title: "Fix login redirect", notes: "brief", blockedBy: ["cookie"] });
    act(() => seedBoard([cookie, login]));
    const { tauri, user } = renderUi(<KanbanBoard workspaceId={BOARD_WS} />);
    tauri.allowUnhandled();

    expect(ids("On hold")).toEqual(["login"]);
    const held = column("On hold").querySelector('[data-ply-board-card-id="login"]') as HTMLElement;
    expect(within(held).getByText("Blocked by #41")).toBeTruthy();
    expect(held.querySelector("svg.ux-icon")).toBeTruthy();

    // The List says the same in its Status.
    await user.click(screen.getByRole("button", { name: "List" }));
    expect(screen.getByText("Blocked by #41")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Board" }));

    // The blocker ships.
    act(() =>
      useKanban.setState({
        byWorkspace: {
          [BOARD_WS]: {
            cards: [{ ...cookie, lastRunStatus: "success", shipStatus: "shipped", columnId: "complete" }, login],
            loaded: true,
          },
        },
      }),
    );
    expect(ids("Not started")).toEqual(["login"]);
    const free = column("Not started").querySelector('[data-ply-board-card-id="login"]') as HTMLElement;
    expect(within(free).getByText("Ready to start")).toBeTruthy();
    for (const start of ["builder_start", "intake_start", "kanban_card_advance_to_in_progress", "swarm_start"]) {
      expect(tauri.callsOf(start)).toHaveLength(0);
    }
  });
});
