// 1.175.0 (B3, mockup consents.html#b3, 3.1 and 3.3): a card made from the
// issue of somebody outside the repository says so on the Board, until it
// has started on this computer. A collaborator's, or one GitHub said
// nothing of, says nothing.
import { describe, expect, it } from "vitest";
import { KanbanBoard } from "../components/KanbanBoard";
import { act, renderUi } from "./render";
import { boardCard, seedBoard } from "./boardFixtures";

const row = (id: string) =>
  document.querySelector(`[data-board-card-id="${id}"] [data-ply-board-card-outside]`);

// 1.175.0 (D3): a card whose issue changed on GitHub and here says so on
// the Board, in Needs you, on a quiet line.
describe("a card that asks which version to keep, on the Board (D3)", () => {
  it("sits in Needs you with its quiet line; a card with no question has none", () => {
    act(() => {
      seedBoard(
        [
          boardCard("gh-issue-70", {
            title: "Onboarding: shorter welcome",
            notes: "mine",
            ghIssueNumber: 70,
            editConflicts: [{ part: "brief", theirs: "theirs" }],
          }),
          boardCard("gh-issue-71", { notes: "brief", ghIssueNumber: 71 }),
        ],
        { kanbanSyncMode: "githubIssues" } as never,
      );
    });
    renderUi(<KanbanBoard workspaceId="ws-1" />).tauri.allowUnhandled();
    const line = (id: string) =>
      document.querySelector(`[data-board-card-id="${id}"] [data-ply-board-card-edit-waits]`)?.textContent ?? null;
    expect(line("gh-issue-70")).toBe("Changed on GitHub · your edit waits");
    expect(line("gh-issue-71")).toBeNull();
    const column = (id: string) =>
      document.querySelector(`[data-board-card-id="${id}"]`)?.closest("[data-board-column]")?.getAttribute("data-board-column");
    expect(column("gh-issue-70")).toBe("needs-you");
    expect(column("gh-issue-71")).not.toBe("needs-you");
  });
});

describe("an issue from outside the repository, on the Board (B3)", () => {
  it("says who wrote it on a quiet line with its icon, only while nothing started here", () => {
    act(() => {
      seedBoard(
        [
          boardCard("gh-issue-173", { ghIssueNumber: 173, ghAuthor: "drive-by-dev", ghAuthorAssociation: "NONE" }),
          boardCard("gh-issue-161", { ghIssueNumber: 161, ghAuthor: "example-teammate", ghAuthorAssociation: "COLLABORATOR" }),
          // GitHub didn't say: Plyloft doesn't state what it doesn't know.
          boardCard("gh-issue-5", { ghIssueNumber: 5, ghAuthor: "someone" }),
          // Started on this computer: the person has read it and chosen.
          boardCard("gh-issue-170", {
            ghIssueNumber: 170,
            ghAuthor: "drive-by-dev",
            ghAuthorAssociation: "CONTRIBUTOR",
            columnId: "in_progress",
            worktreePath: "/w/170",
            lastRunStatus: "running",
          }),
          // An outsider's issue a collaborator edited last is still theirs.
          boardCard("gh-issue-7", { ghIssueNumber: 7, ghAuthor: "drive-by-dev", ghAuthorAssociation: "NONE", ghLastEditor: "matteo" }),
        ],
        { kanbanSyncMode: "githubIssues" } as never,
      );
    });
    renderUi(<KanbanBoard workspaceId="ws-1" />).tauri.allowUnhandled();
    expect(row("gh-issue-173")?.textContent).toBe("From outside the repository · drive-by-dev");
    expect(row("gh-issue-173")?.querySelector("svg")).toBeTruthy();
    // Calm: the same quiet line as a teammate's pull request, no chip.
    expect(row("gh-issue-173")?.className).toContain("board-card-fact--quiet");
    expect(row("gh-issue-7")?.textContent).toBe("From outside the repository · drive-by-dev");
    expect(row("gh-issue-161")).toBeNull();
    expect(row("gh-issue-5")).toBeNull();
    expect(row("gh-issue-170")).toBeNull();
  });
});
