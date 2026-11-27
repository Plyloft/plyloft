// QoL 1.168 S1-3: every archived card has Restore — one archived without
// shipping too — and the toast says what came back.
import { describe, expect, it } from "vitest";
import { KanbanBoard } from "../components/KanbanBoard";
import { act, renderUi, screen, tauri, waitFor, within } from "./render";
import { boardCard, seedBoard, BOARD_WS } from "./boardFixtures";

describe("Restore in Archived", () => {
  it("brings back a card archived without shipping, with its copy", async () => {
    act(() =>
      seedBoard([
        boardCard("away", {
          title: "Half done",
          archived: true,
          archivedAt: 5,
          branchCleanup: { branch: "plyloft/card-away-half-done", tip: "abc", reason: "archived", since: 5 },
        } as never),
      ]),
    );
    tauri().fixture("kanban_card_restore", {
      ...boardCard("away", { title: "Half done" }),
      worktreePath: "/tmp/ply-test/.plyloft-worktrees/away",
    });
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />, { withToasts: true });
    await r.user.click(screen.getByRole("button", { name: /Archived/ }));
    const item = document.querySelector(".board-archive-item") as HTMLElement;
    const restore = within(item).getByRole("button", { name: /Restore/ });
    expect(restore.getAttribute("title")).toMatch(/brief, plan and branch/);
    await r.user.click(restore);
    await waitFor(() => expect(tauri().callsOf("kanban_card_restore")).toHaveLength(1));
    expect(
      await screen.findByText(/Half done is back with its copy/),
    ).toBeTruthy();
  });
});
