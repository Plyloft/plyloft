// Team walk 2026-10-02 (T2): a GitHub-backed card someone else holds, which
// this Mac has not run, says who has it on the Board tile instead of "Ready to
// start" — a member must not take it for a free card. Mine reads as its state.
import { describe, expect, it } from "vitest";
import { KanbanBoard } from "../components/KanbanBoard";
import { useIdentity } from "../store/identityStore";
import { useKanban } from "../store/kanbanStore";
import { act, fireEvent, renderUi, screen, tauri, waitFor, within } from "./render";
import { boardCard, seedBoard } from "./boardFixtures";
import { setTeamAllowed } from "./planGates";

const fact = (id: string) =>
  document.querySelector(`[data-board-card-id="${id}"] .board-card-fact`)?.textContent ?? "";

describe("the Board tile and a claim (T2)", () => {
  it("says Claimed by <login> for someone else's card, and its state for mine", () => {
    act(() => {
      useIdentity.setState({ githubLogin: "member", githubLoginAt: Date.now() });
      seedBoard([
        boardCard("gh-issue-20", {
          title: "Team: calcHalf",
          notes: "Add calcHalf.",
          ghIssueNumber: 20,
          ghAssignees: ["owner"],
        }),
        boardCard("gh-issue-21", {
          title: "Team: calcTriple",
          notes: "Add calcTriple.",
          ghIssueNumber: 21,
          ghAssignees: ["member"],
        }),
        boardCard("gh-issue-22", {
          title: "Ran here",
          notes: "x",
          ghIssueNumber: 22,
          ghAssignees: ["owner"],
          lastRunStatus: "failed",
          columnId: "in_progress",
          worktreePath: "/w/22",
        }),
      ]);
    });
    tauri().allowUnhandled();
    renderUi(<KanbanBoard workspaceId="ws-1" />);
    expect(fact("gh-issue-20")).toBe("Claimed by owner · #20");
    // U2: mine says so, in the state's place.
    expect(fact("gh-issue-21")).toBe("Claimed by you · #21");
    // This Mac ran it: its own state.
    expect(fact("gh-issue-22")).toBe("Stopped · #22");
  });

  it("U3: offers Claim from the Board's menu, Claim it too on someone else's card, nothing on mine", async () => {
    act(() => {
      useIdentity.setState({ githubLogin: "member", githubLoginAt: Date.now() });
      seedBoard(
        [
          boardCard("gh-issue-40", { title: "Free", notes: "x", ghIssueNumber: 40 }),
          boardCard("gh-issue-41", { title: "Theirs", notes: "x", ghIssueNumber: 41, ghAssignees: ["owner"] }),
          boardCard("gh-issue-42", { title: "Mine", notes: "x", ghIssueNumber: 42, ghAssignees: ["member"] }),
        ],
        { kanbanSyncMode: "githubIssues", githubOwnerRepo: "o/lyra" } as never,
      );
    });
    setTeamAllowed(true);
    tauri().allowUnhandled();
    const r = renderUi(<KanbanBoard workspaceId="ws-1" />, {
      fixtures: {
        kanban_card_claim: () => ({
          card: boardCard("gh-issue-40", { title: "Free", notes: "x", ghIssueNumber: 40, ghAssignees: ["member"] }),
          claimed: true,
          holder: { kind: "mine" },
        }),
      },
    });
    const tile = (id: string) => document.querySelector<HTMLElement>(`[data-ply-board-card-id="${id}"]`)!;

    fireEvent.contextMenu(tile("gh-issue-42"));
    let menu = await screen.findByRole("menu", { name: "Card: Mine" });
    expect(within(menu).queryByRole("menuitem", { name: /^Claim/ })).toBeNull();
    await r.user.keyboard("{Escape}");

    fireEvent.contextMenu(tile("gh-issue-41"));
    menu = await screen.findByRole("menu", { name: "Card: Theirs" });
    expect(within(menu).getByRole("menuitem", { name: "Claim it too…" })).toBeTruthy();
    await r.user.keyboard("{Escape}");

    fireEvent.contextMenu(tile("gh-issue-40"));
    menu = await screen.findByRole("menu", { name: "Card: Free" });
    await r.user.click(within(menu).getByRole("menuitem", { name: "Claim" }));
    await waitFor(() => expect(r.tauri.callsOf("kanban_card_claim")).toHaveLength(1));
    expect(r.tauri.callsOf("kanban_card_claim")[0].args).toMatchObject({ workspaceId: "ws-1", cardId: "gh-issue-40" });
  });

  it("U28: the tile names a teammate's open pull request, read once for the Board", async () => {
    const cards = [
      boardCard("gh-issue-20", { title: "Theirs", notes: "x", ghIssueNumber: 20, ghAssignees: ["owner"] }),
      boardCard("gh-issue-21", { title: "Other", notes: "x", ghIssueNumber: 21 }),
    ];
    act(() => {
      useIdentity.setState({ githubLogin: "member", githubLoginAt: Date.now() });
      seedBoard(
        cards,
        { kanbanSyncMode: "githubIssues", githubOwnerRepo: "o/lyra" } as never,
      );
    });
    setTeamAllowed(true);
    tauri().allowUnhandled();
    const r = renderUi(<KanbanBoard workspaceId="ws-1" />, {
      fixtures: {
        kanban_github_reconcile: () => ({ created: 0, patched: 0, missing: [], prunedWorktrees: 0 }),
        kanban_load: () => cards,
        kanban_open_pr_links: [{ issue: 20, number: 23, author: "owner" }],
      },
    });
    await waitFor(() =>
      expect(document.querySelector('[data-board-card-id="gh-issue-20"] [data-ply-board-card-teammate-pr]')?.textContent).toBe(
        "Pull request #23 by owner",
      ),
    );
    expect(document.querySelector('[data-board-card-id="gh-issue-21"] [data-ply-board-card-teammate-pr]')).toBeNull();
    expect(r.tauri.callsOf("kanban_open_pr_links")).toHaveLength(1);
    // A later read says it's gone (merged): the tile drops it. A failed one keeps it.
    r.tauri.fixture("kanban_open_pr_links", () => {
      throw "offline";
    });
    await act(async () => useKanban.getState().readOpenPrLinks("ws-1"));
    expect(document.querySelector('[data-board-card-id="gh-issue-20"] [data-ply-board-card-teammate-pr]')).toBeTruthy();
    r.tauri.fixture("kanban_open_pr_links", []);
    await act(async () => useKanban.getState().readOpenPrLinks("ws-1"));
    expect(document.querySelector('[data-board-card-id="gh-issue-20"] [data-ply-board-card-teammate-pr]')).toBeNull();
  });

  it("U32: a move on a GitHub board refused for its folder leaves no claim behind", async () => {
    const card = boardCard("gh-issue-50", { title: "Move me", notes: "x", ghIssueNumber: 50 });
    act(() => {
      useIdentity.setState({ githubLogin: "member", githubLoginAt: Date.now() });
      seedBoard([card], { kanbanSyncMode: "githubIssues", githubOwnerRepo: "o/lyra" } as never);
    });
    setTeamAllowed(true);
    tauri().allowUnhandled();
    tauri().fixture("project_folder_check", "This project's folder isn't a git repository, so nothing was claimed.");
    await act(async () => {
      await useKanban.getState().moveCard("gh-issue-50", "in_progress");
    });
    expect(tauri().callsOf("project_folder_check")).toHaveLength(1);
    expect(tauri().callsOf("kanban_card_claim")).toHaveLength(0);
    expect(tauri().callsOf("kanban_card_claim_state")).toHaveLength(0);
    expect(tauri().callsOf("kanban_card_advance_to_in_progress")).toHaveLength(0);
  });

  it("U3: no Claim on a board that isn't on GitHub Issues", async () => {
    act(() => {
      useIdentity.setState({ githubLogin: "member", githubLoginAt: Date.now() });
      seedBoard([boardCard("gh-issue-40", { title: "Free", notes: "x", ghIssueNumber: 40 })]);
    });
    tauri().allowUnhandled();
    renderUi(<KanbanBoard workspaceId="ws-1" />);
    fireEvent.contextMenu(document.querySelector<HTMLElement>('[data-ply-board-card-id="gh-issue-40"]')!);
    const menu = await screen.findByRole("menu", { name: "Card: Free" });
    expect(within(menu).queryByRole("menuitem", { name: /^Claim/ })).toBeNull();
  });

  it("leaves every started, finished or held card its own word (Reviewer round 2)", () => {
    act(() => {
      useIdentity.setState({ githubLogin: "member", githubLoginAt: Date.now() });
      seedBoard([
        boardCard("blocker", { title: "Blocker", ghIssueNumber: 30, notes: "x" }),
        boardCard("done", {
          title: "Closed on GitHub",
          notes: "x",
          ghIssueNumber: 31,
          ghAssignees: ["owner"],
          columnId: "complete",
        }),
        boardCard("held", {
          title: "Waits",
          notes: "x",
          ghIssueNumber: 32,
          ghAssignees: ["owner"],
          blockedBy: ["blocker"],
        }),
        boardCard("planning", {
          title: "Being planned",
          ghIssueNumber: 33,
          ghAssignees: ["owner"],
          intakeStatus: "active",
        }),
      ]);
    });
    tauri().allowUnhandled();
    renderUi(<KanbanBoard workspaceId="ws-1" />);
    expect(fact("done")).toBe("Closed · #31");
    expect(fact("held")).toBe("Blocked by #30");
    expect(fact("planning")).not.toContain("Claimed");
  });

  it("says nothing about a claim while this Mac's GitHub login is unknown", () => {
    act(() => {
      useIdentity.setState({ githubLogin: null, githubLoginAt: Date.now() });
      seedBoard([
        boardCard("gh-issue-20", { notes: "x", ghIssueNumber: 20, ghAssignees: ["owner"] }),
      ]);
    });
    tauri().allowUnhandled();
    renderUi(<KanbanBoard workspaceId="ws-1" />);
    expect(fact("gh-issue-20")).toBe("Ready to start · #20");
  });

  // N14 (item 5): someone else's card that this Mac has not run waits on
  // them — under On hold, out of Not started and its count.
  it("puts a card someone else holds under On hold, out of Not started and its count", () => {
    act(() => {
      useIdentity.setState({ githubLogin: "member", githubLoginAt: Date.now() });
      seedBoard([
        boardCard("gh-issue-20", { notes: "x", ghIssueNumber: 20, ghAssignees: ["owner"], columnId: "in_progress" }),
        boardCard("gh-issue-21", { notes: "x", ghIssueNumber: 21, ghAssignees: ["member"] }),
        boardCard("gh-issue-23", { notes: "x", ghIssueNumber: 23 }),
        boardCard("gh-issue-22", {
          notes: "x",
          ghIssueNumber: 22,
          ghAssignees: ["owner"],
          lastRunStatus: "failed",
          columnId: "in_progress",
          worktreePath: "/w/22",
        }),
      ]);
    });
    tauri().allowUnhandled();
    renderUi(<KanbanBoard workspaceId="ws-1" />);
    const column = (name: string) => screen.getByRole("region", { name: new RegExp(`^${name}`) });
    const ids = (name: string) =>
      Array.from(column(name).querySelectorAll("[data-ply-board-card-id]")).map((el) =>
        el.getAttribute("data-ply-board-card-id"),
      );
    expect(ids("On hold")).toEqual(["gh-issue-20"]);
    // gh-issue-22 failed here: it asks the person, in Needs you.
    expect(ids("Not started")).toEqual(["gh-issue-21", "gh-issue-23"]);
    expect(ids("Needs you")).toEqual(["gh-issue-22"]);
    expect(within(column("Not started")).getByRole("heading").textContent).toBe("Not started2");
    expect(fact("gh-issue-20")).toBe("Claimed by owner · #20");
  });

  it("leaves someone else's card in Not started while this Mac's GitHub login is unknown", () => {
    act(() => {
      useIdentity.setState({ githubLogin: null, githubLoginAt: Date.now() });
      seedBoard([boardCard("gh-issue-20", { notes: "x", ghIssueNumber: 20, ghAssignees: ["owner"] })]);
    });
    tauri().allowUnhandled();
    renderUi(<KanbanBoard workspaceId="ws-1" />);
    const needs = screen.getByRole("region", { name: /^Not started/ });
    expect(needs.querySelector('[data-ply-board-card-id="gh-issue-20"]')).not.toBeNull();
  });
});
