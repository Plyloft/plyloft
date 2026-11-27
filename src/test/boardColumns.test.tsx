// UX-5.2: the Board's columns are by attention — Needs you, Not started,
// Working, On hold, Done (QoL 1.168 block 8, owner D13) — derived from each card's state, whatever its persisted
// column says. Each heading carries its count.
import { describe, expect, it } from "vitest";
import { KanbanBoard } from "../components/KanbanBoard";
import { act, renderUi, screen, within } from "./render";
import { seedBoard, boardCard } from "./boardFixtures";

describe("the Board's attention columns", () => {
  it("puts each card in the column its state asks for, with counts", () => {
    act(() =>
      seedBoard([
        boardCard("draft", { title: "Write the brief" }),
        boardCard("failed", {
          title: "Rate-limit the search endpoint",
          columnId: "in_progress",
          lastRunStatus: "failed",
        }),
        boardCard("running", {
          title: "Dark mode for settings",
          columnId: "in_progress",
          lastRunStatus: "running",
        }),
        boardCard("checks", {
          title: "Tile header states",
          columnId: "complete",
          verifyStatus: "running",
        }),
        boardCard("queued", {
          title: "Export the board as CSV",
          columnId: "in_progress",
          swarmTemplateId: "feature",
        }),
        boardCard("shipped", {
          title: "Toasts at the bottom",
          columnId: "complete",
          shipStatus: "shipped",
        }),
        boardCard("archived", {
          title: "Old thing",
          columnId: "complete",
          archived: true,
        }),
      ]),
    );
    renderUi(<KanbanBoard workspaceId="ws-1" />);

    const column = (name: string) =>
      screen.getByRole("region", { name: new RegExp(`^${name}`) });
    const titles = (name: string) =>
      Array.from(
        column(name).querySelectorAll("[data-ply-board-card-id]"),
      ).map((el) => el.getAttribute("data-ply-board-card-id"));

    expect(titles("Needs you")).toEqual(["failed"]);
    expect(titles("Not started")).toEqual(["draft"]);
    expect(titles("Working")).toEqual(["running", "checks"]);
    expect(titles("On hold")).toEqual(["queued"]);
    expect(titles("Done")).toEqual(["shipped"]);
    expect(within(column("Needs you")).getByRole("heading").textContent).toBe(
      "Needs you1",
    );
    expect(within(column("Done")).getByRole("heading").textContent).toBe("Done1");
    // The archive is not a column.
    expect(document.querySelector('[data-ply-board-card-id="archived"]')).toBeNull();
  });

  it("draws a card as its whole title and one fact line — no branch, no provenance", () => {
    const long =
      "Rate-limit the search endpoint so a burst of typing in the command palette never hits the backend more than once a frame";
    act(() =>
      seedBoard(
        [
          boardCard("issue", {
            title: long,
            ghIssueNumber: 42,
            branchName: "atelier/card-issue-rate-limit",
          }),
          boardCard("shipped", {
            title: "Toasts at the bottom",
            columnId: "complete",
            shipStatus: "shipped",
            shippedVersion: "v1.150",
            branchName: "atelier/card-shipped",
          }),
        ],
        { kanbanSyncMode: "githubIssues" },
      ),
    );
    renderUi(<KanbanBoard workspaceId="ws-1" />);
    const card = screen.getByRole("button", { name: new RegExp(`^${long}`) });
    expect(card.querySelector(".board-card-title")?.textContent).toBe(long);
    expect(card.getAttribute("title")).toBe(long);
    // 1.171.0 C1 (CF5): a card with only its title is Ready to start.
    expect(card.querySelector(".board-card-fact")?.textContent).toBe("Ready to start · #42");
    const shipped = screen.getByRole("button", { name: /^Toasts at the bottom/ });
    expect(shipped.querySelector(".board-card-fact")?.textContent).toBe("Shipped · v1.150");
    expect(document.body.textContent).not.toMatch(/atelier\/card-/);
    expect(document.body.textContent).not.toMatch(/Local only/);
  });
});
