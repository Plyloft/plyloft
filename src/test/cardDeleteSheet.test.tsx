// GH #276: the Delete card sheet over work that exists only on this Mac —
// words first (no path, no trash rule in the first layer), and the choice
// that loses the work as the lead action, apart from Cancel and the safe one.
import { describe, expect, it } from "vitest";
import { useCardDelete } from "../components/CardDeleteDialog";
import { useIdentity } from "../store/identityStore";
import { boardCard } from "./boardFixtures";
import { nextFrame, renderUi, screen, waitFor, within } from "./render";

function Harness() {
  const { requestDelete, dialog } = useCardDelete();
  return (
    <>
      <button type="button" onClick={() => requestDelete(boardCard("fx-checks-failed"))}>
        Ask
      </button>
      {dialog}
    </>
  );
}

describe("the Delete card sheet", () => {
  const worktreeRead = {
    kanban_card_worktree_state: {
      disposition: "remove",
      path: null,
      branch: null,
      dirtyFiles: 0,
      unpushedCommits: 0,
      liveSession: false,
      unreadable: false,
      busy: null,
      cardBranch: null,
      cardBranchCommits: 0,
    },
  };
  function ClaimHarness({ assignees }: { assignees: string[] }) {
    const { requestDelete, dialog } = useCardDelete();
    const card = boardCard("gh-issue-9", { ghIssueNumber: 9, ghAssignees: assignees });
    return (
      <>
        <button type="button" onClick={() => requestDelete(card)}>
          Ask
        </button>
        {dialog}
      </>
    );
  }

  it("U9: warns when a teammate holds the card, and not when I do", async () => {
    useIdentity.setState({ githubLogin: "me", githubLoginAt: Date.now() });
    const first = renderUi(<ClaimHarness assignees={["ana"]} />, { fixtures: worktreeRead });
    await first.user.click(screen.getByRole("button", { name: "Ask" }));
    await nextFrame();
    expect(screen.getByRole("dialog", { name: "Delete card?" }).textContent).toContain(
      "Claimed by ana. Deleting it closes the issue for everyone.",
    );
    first.unmount();

    const mine = renderUi(<ClaimHarness assignees={["ME"]} />, { fixtures: worktreeRead });
    await mine.user.click(screen.getByRole("button", { name: "Ask" }));
    await nextFrame();
    expect(screen.getByRole("dialog", { name: "Delete card?" }).textContent).not.toContain("Deleting it closes the issue for everyone.");
  });

  it("says what is at stake in words, the path behind Details, Delete everything on the left", async () => {
    const r = renderUi(<Harness />, {
      fixtures: {
        kanban_card_worktree_state: {
          disposition: "ask",
          path: "/Users/someone/code/lyra/.atelier-worktrees/fx-checks-failed",
          branch: "atelier/card-fx",
          dirtyFiles: 3,
          unpushedCommits: 2,
          liveSession: false,
          unreadable: false,
          busy: null,
          cardBranch: "atelier/card-fx",
          cardBranchCommits: 2,
        },
      },
    });
    await r.user.click(screen.getByRole("button", { name: "Ask" }));
    await nextFrame();
    const sheet = screen.getByRole("dialog", { name: "Delete card?" });
    expect(sheet.textContent).toContain(
      "This card has 2 commits and 3 changed files that exist only on this Mac.",
    );
    // 1.168.1 (A4): what the delete keeps.
    expect(sheet.textContent).toContain("Its runs and checks stay in History.");
    // No path or trash rule outside the Details disclosure.
    const details = sheet.querySelector("details.ux-details");
    expect(details).toBeTruthy();
    expect(details!.hasAttribute("open")).toBe(false);
    expect(details!.textContent).toContain(".atelier-worktrees/fx-checks-failed");
    expect(details!.textContent).toContain(".trash/");
    const outside = [...sheet.querySelectorAll("p")]
      .filter((p) => !details!.contains(p))
      .map((p) => p.textContent)
      .join(" ");
    expect(outside).not.toMatch(/\/Users|\.trash|GC/);

    // The foot: Delete everything leads, the safe ones sit on the right.
    const foot = sheet.querySelector(".ux-sheet-foot")!;
    const order = [...foot.children].map((c) =>
      c.classList.contains("ux-sheet-spacer") ? "|" : c.textContent,
    );
    expect(order).toEqual(["Delete everything", "|", "Cancel", "Keep the folder"]);
    expect(within(sheet).getByRole("button", { name: "Delete everything" }).className).toContain(
      "ux-danger-fill",
    );
    // Owner decision 2026-09-30: focus opens on Cancel, never on the lead
    // Delete that comes first in the foot.
    await waitFor(() => expect(document.activeElement).toBe(within(sheet).getByRole("button", { name: "Cancel" })));
  });

  it("keeps a lone Delete as the primary on the right", async () => {
    const r = renderUi(<Harness />, {
      fixtures: {
        kanban_card_worktree_state: {
          disposition: "remove",
          path: null,
          branch: null,
          dirtyFiles: 0,
          unpushedCommits: 0,
          liveSession: false,
          unreadable: false,
          busy: null,
          cardBranch: null,
          cardBranchCommits: 0,
        },
      },
    });
    await r.user.click(screen.getByRole("button", { name: "Ask" }));
    await nextFrame();
    const foot = screen.getByRole("dialog", { name: "Delete card?" }).querySelector(".ux-sheet-foot")!;
    const order = [...foot.children].map((c) =>
      c.classList.contains("ux-sheet-spacer") ? "|" : c.textContent,
    );
    expect(order).toEqual(["|", "Cancel", "Delete"]);
  });
  it("in a repository with no origin, says the commits aren't on the target branch and lists them under Details (n16)", async () => {
    const r = renderUi(<Harness />, {
      fixtures: {
        kanban_card_worktree_state: {
          disposition: "ask",
          path: "/Users/someone/code/lyra/.atelier-worktrees/fx-checks-failed",
          branch: "atelier/card-fx",
          dirtyFiles: 0,
          unpushedCommits: 1,
          liveSession: false,
          unreadable: false,
          busy: null,
          cardBranch: "atelier/card-fx",
          cardBranchCommits: 1,
          hasOrigin: false,
          targetBranch: "main",
          localOnlySubjects: ["abc1234 build: snapshot 3"],
        },
      },
    });
    await r.user.click(screen.getByRole("button", { name: "Ask" }));
    await nextFrame();
    const sheet = screen.getByRole("dialog", { name: "Delete card?" });
    expect(sheet.textContent).toContain("This card has 1 commit that isn't on main.");
    expect(sheet.textContent).not.toContain("only on this Mac");
    const details = sheet.querySelector("details.ux-details")!;
    expect(details.textContent).toContain("Its commit:");
    expect(details.textContent).toContain("abc1234 build: snapshot 3");
  });
});
