// UX-5.9: Undo on the Board's move and delete. A move goes back to the
// order it had; a delete (and a drag to the archive) leaves the Board at
// once, offers Undo for 8 s, and is written only when the window ends —
// Undo inside it means nothing was ever deleted.
import { describe, expect, it, vi } from "vitest";
import { KanbanBoard } from "../components/KanbanBoard";
import { ATELIER_CARD_TYPE } from "../lib/dropGuard";
import { act, fireEvent, renderUi, screen, tauri, waitFor, within } from "./render";
import { boardCard, seedBoard, BOARD_WS } from "./boardFixtures";

const ids = () =>
  Array.from(document.querySelectorAll("[data-board-card-id]")).map((el) =>
    el.getAttribute("data-board-card-id"),
  );

function carrying(cardId: string) {
  return {
    dataTransfer: {
      types: [ATELIER_CARD_TYPE, "text/plain"],
      getData: () => cardId,
      dropEffect: "move",
    },
  };
}

const worktreeNone = {
  disposition: "remove",
  path: null,
  branch: null,
  dirtyFiles: 0,
  unpushedCommits: 0,
  liveSession: false,
  unreadable: false,
  busy: null,
  cardBranch: null,
  cardBranchCommits: null,
};

function seed() {
  act(() =>
    seedBoard([
      boardCard("keep", { title: "Keep me", createdAt: 100 }),
      boardCard("doomed", { title: "Delete me", createdAt: 200 }),
    ]),
  );
  tauri().fixture("kanban_card_worktree_state", worktreeNone);
  tauri().fixture("kanban_card_delete", {
    worktreeRemoved: false,
    branchRemoved: false,
    keptPath: null,
    problem: null,
    keptInTrash: null,
    keptReason: null,
  });
  tauri().fixture("kanban_attachment_gc_card", null);
}

async function deleteDoomed(r: ReturnType<typeof renderUi>) {
  fireEvent.contextMenu(screen.getByRole("button", { name: /^Delete me/ }));
  await r.user.click(screen.getByRole("menuitem", { name: "Delete card…" }));
  const sheet = await screen.findByRole("dialog", { name: "Delete card?" });
  const confirm = await within(sheet).findByRole("button", { name: "Delete" });
  await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false));
  await r.user.click(confirm);
}

describe("Undo on the Board", () => {
  it("a deleted card is gone at once and back on Undo — nothing was deleted", async () => {
    seed();
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />, {
      withToasts: true,
      fakeTimers: true,
    });
    await deleteDoomed(r);
    expect(ids()).toEqual(["keep"]);
    await act(async () => {
      await Promise.resolve();
    });
    // Still restorable to the end of its 6 s window (GH #296).
    act(() => void vitestAdvance(5_900));
    await r.user.click(screen.getByRole("button", { name: "Undo" }));
    expect(ids()).toEqual(["keep", "doomed"]);
    act(() => void vitestAdvance(10_000));
    expect(tauri().callsOf("kanban_card_delete")).toHaveLength(0);
  });

  it("the delete is written when the Undo window ends", async () => {
    seed();
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />, {
      withToasts: true,
      fakeTimers: true,
    });
    await deleteDoomed(r);
    expect(tauri().callsOf("kanban_card_delete")).toHaveLength(0);
    await act(async () => {
      vitestAdvance(8_000);
      await Promise.resolve();
    });
    await waitFor(() => expect(tauri().callsOf("kanban_card_delete")).toHaveLength(1));
    expect(tauri().callsOf("kanban_card_delete")[0].args.cardId).toBe("doomed");
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("a drag to the archive waits out its Undo too", async () => {
    seed();
    tauri().fixture("kanban_card_archive", { ...boardCard("doomed"), archived: true });
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />, {
      withToasts: true,
      fakeTimers: true,
    });
    // QoL 1.168 S1-3: the Archived row, shown while a card is dragged.
    await act(async () => {
      fireEvent.dragEnter(document.body, carrying("doomed"));
    });
    await act(async () => {
      fireEvent.drop(document.querySelector("[data-board-archive]")!, carrying("doomed"));
    });
    expect(ids()).toEqual(["keep"]);
    expect(screen.getByText("Card archived.")).toBeTruthy();
    await r.user.click(screen.getByRole("button", { name: "Undo" }));
    act(() => void vitestAdvance(10_000));
    expect(tauri().callsOf("kanban_card_archive")).toHaveLength(0);
    expect(ids()).toEqual(["keep", "doomed"]);
  });

  // 1.175.0 (D2): on a GitHub Issues board the archive takes the member's
  // own name off the issue. The toast with Undo says so; once the archive
  // is written, a second one says so only when GitHub refused.
  it("an archived card's toast says the member's name comes off, and says when GitHub refused", async () => {
    const { useIdentity } = await import("../store/identityStore");
    const { useWorkspaces } = await import("../store/workspaceStore");
    act(() => {
      seedBoard([
        boardCard("keep", { title: "Keep me", createdAt: 100 }),
        boardCard("doomed", { title: "Delete me", createdAt: 200, ghIssueNumber: 161, ghAssignees: ["member"] }),
      ]);
      useIdentity.setState({ githubLogin: "member", githubLoginAt: Date.now() });
      useWorkspaces.setState((s) => ({
        workspaces: s.workspaces.map((w) => ({ ...w, kanbanSyncMode: "githubIssues" as const })),
      }));
    });
    tauri().fixture("kanban_card_archive", { ...boardCard("doomed"), archived: true });
    tauri().fixture("card_name_off_outcome", { kind: "refused", number: 161, details: "HTTP 502: Bad Gateway" });
    renderUi(<KanbanBoard workspaceId={BOARD_WS} />, { withToasts: true, fakeTimers: true });
    await act(async () => {
      fireEvent.dragEnter(document.body, carrying("doomed"));
    });
    await act(async () => {
      fireEvent.drop(document.querySelector("[data-board-archive]")!, carrying("doomed"));
    });
    expect(screen.getByText("Card archived.")).toBeTruthy();
    expect(screen.getByText("Delete me. Your name is off issue #161.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
    expect(tauri().callsOf("card_name_off_outcome")).toHaveLength(0);
    await act(async () => {
      vitestAdvance(8_000);
      await Promise.resolve();
    });
    await waitFor(() => expect(tauri().callsOf("kanban_card_archive")).toHaveLength(1));
    await waitFor(() => expect(tauri().callsOf("card_name_off_outcome")).toHaveLength(1));
    expect(
      await screen.findByText(
        "Delete me. GitHub didn't take your name off issue #161, so your team still sees it as yours. Plyloft tries again at the next Sync.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(screen.getByRole("button", { name: "Details" })).toBeTruthy();
  });

  it("a move goes back to the order it had", async () => {
    seed();
    tauri().fixture("kanban_card_set_board_order", (args: Record<string, unknown>) => ({
      ...boardCard(String(args.cardId), {
        title: "Keep me",
        createdAt: 100,
      }),
      ...(args.boardOrder === null ? {} : { boardOrder: args.boardOrder }),
    }));
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />, { withToasts: true });
    // "Keep me" released on "Delete me" (after it: jsdom lays nothing out).
    const doomed = document.querySelector('[data-board-card-id="doomed"]')!;
    await act(async () => {
      fireEvent.drop(doomed, carrying("keep"));
    });
    await waitFor(() => expect(ids()).toEqual(["doomed", "keep"]));
    await r.user.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(ids()).toEqual(["keep", "doomed"]));
    const calls = tauri().callsOf("kanban_card_set_board_order").map((c) => c.args.boardOrder);
    expect(calls).toEqual([1200, null]);
  });
});

function vitestAdvance(ms: number) {
  vi.advanceTimersByTime(ms);
}
