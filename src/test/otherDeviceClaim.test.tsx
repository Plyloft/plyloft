// 1.173.0 (C2, mockup two-macs.html scene 1): the same person on two Macs.
// A card the MacBook Pro took reads "On your MacBook Pro · 2 h ago" on the
// Mac mini, and Start asks first (Cancel · Start here too · Take it over
// here). With one Mac, another login or a local board, nothing shows.
import { describe, expect, it } from "vitest";
import { KanbanBoard } from "../components/KanbanBoard";
import { useIdentity } from "../store/identityStore";
import { useKanban } from "../store/kanbanStore";
import { useToasts } from "../store/toastStore";
import { act, renderUi, screen, waitFor, within } from "./render";
import { boardCard, seedBoard } from "./boardFixtures";

const at = new Date(Date.now() - 2 * 3_600_000).toISOString();
const proClaim = { device: "dev-pro", name: "MacBook Pro", login: "matteo", at };

const deviceLine = (id: string) =>
  document.querySelector(`[data-board-card-id="${id}"] [data-ply-board-card-device]`)?.textContent ?? null;

describe("a card claimed on your other Mac (C2)", () => {
  it("says which Mac took it on the Board tile, and nothing otherwise", () => {
    act(() => {
      useIdentity.setState({ githubLogin: "matteo", githubLoginAt: Date.now() });
      seedBoard(
        [
          boardCard("gh-issue-1", { ghIssueNumber: 1, ghAssignees: ["matteo"], columnId: "in_progress", ghClaim: proClaim }),
          boardCard("gh-issue-2", {
            ghIssueNumber: 2,
            ghAssignees: ["matteo"],
            columnId: "in_progress",
            worktreePath: "/w/2",
            lastRunStatus: "failed",
            ghClaim: proClaim,
            ghClaimLostTo: "MacBook Pro",
          }),
          boardCard("gh-issue-3", {
            ghIssueNumber: 3,
            ghAssignees: ["matteo"],
            ghClaim: { ...proClaim, device: "dev-mini" },
            ghClaimHere: true,
          }),
          // Built here too (Start here too), never taken over: still "On your …".
          boardCard("gh-issue-6", {
            ghIssueNumber: 6,
            ghAssignees: ["matteo"],
            columnId: "in_progress",
            worktreePath: "/w/6",
            ghClaim: proClaim,
          }),
          boardCard("gh-issue-4", { ghIssueNumber: 4, ghAssignees: ["teammate"], ghClaim: { ...proClaim, login: "teammate" } }),
          boardCard("gh-issue-5", { ghIssueNumber: 5, ghAssignees: ["matteo"] }),
        ],
        { kanbanSyncMode: "githubIssues" } as never,
      );
    });
    renderUi(<KanbanBoard workspaceId="ws-1" />).tauri.allowUnhandled();
    expect(deviceLine("gh-issue-1")).toBe("On your MacBook Pro · 2 h ago");
    expect(deviceLine("gh-issue-2")).toBe("Taken over by MacBook Pro");
    expect(deviceLine("gh-issue-3")).toBeNull();
    expect(deviceLine("gh-issue-4")).toBeNull();
    expect(deviceLine("gh-issue-5")).toBeNull();
    expect(deviceLine("gh-issue-6")).toBe("On your MacBook Pro · 2 h ago");
  });

  const start = async (answer: "Cancel" | "Start here too" | "Take it over here", failTakeOver = false) => {
    const card = boardCard("gh-issue-7", {
      title: "Search terms: sort by impressions",
      ghIssueNumber: 7,
      ghAssignees: ["matteo"],
      columnId: "in_progress",
      ghClaim: proClaim,
    });
    act(() => {
      useIdentity.setState({ githubLogin: "matteo", githubLoginAt: Date.now() });
      seedBoard([card], { kanbanSyncMode: "githubIssues" } as never);
    });
    const { user, tauri } = renderUi(<div />, {
      fixtures: {
        kanban_card_claim_state: () => ({ claimed: true, holder: { kind: "mine" }, card }),
        kanban_card_device_claim: (args: Record<string, unknown>) => {
          if (failTakeOver) throw new Error("gh: HTTP 502 Bad Gateway");
          return {
          ...card,
          ghClaim: { device: "dev-mini", name: "Mac mini", login: "matteo", at: new Date().toISOString(), took: args.takeOver },
          ghClaimHere: true,
        };
        },
      },
    });
    tauri.allowUnhandled();
    let outcome: string | null = null;
    void useKanban
      .getState()
      .claimBeforeBuild("ws-1", "gh-issue-7")
      .then((o) => (outcome = o));
    const sheet = await screen.findByRole("dialog", { name: "This card is being built on your MacBook Pro" });
    const cancel = within(sheet).getByRole("button", { name: "Cancel" });
    await waitFor(() => expect(document.activeElement).toBe(cancel));
    // Cancel is the strong button; the take-over sentence is the body's hint.
    expect(cancel.className).toContain("cbtn--strong");
    expect(within(sheet).getByRole("button", { name: "Take it over here" }).className).toContain("cbtn--accent");
    expect(sheet.querySelector(".ux-sheet-hint")?.textContent).toBe(
      "Take it over if you've left the MacBook Pro: its copy stays there until you delete it.",
    );
    await user.click(within(sheet).getByRole("button", { name: answer }));
    await waitFor(() => expect(outcome).not.toBeNull());
    return { outcome: outcome as string | null, writes: tauri.callsOf("kanban_card_device_claim") };
  };

  it("a take-over that didn't reach GitHub says so in plain words and starts nothing", async () => {
    const { outcome } = await start("Take it over here", true);
    expect(outcome).toBe("cancel");
    const toast = useToasts.getState().toasts.find((t) => t.title === "Not taken over");
    expect(toast?.body).toBe("The card is still marked as being built on your other Mac. Check the connection and try again.");
    expect(toast?.details).toContain("502");
  });

  it("asks before a start: Cancel starts nothing and writes nothing", async () => {
    const { outcome, writes } = await start("Cancel");
    expect(outcome).toBe("cancel");
    expect(writes).toHaveLength(0);
  });

  it("Start here too starts without moving the claim", async () => {
    const { outcome, writes } = await start("Start here too");
    expect(outcome).toBe("go");
    expect(writes).toHaveLength(0);
  });

  it("Take it over here moves the claim to this Mac", async () => {
    const { outcome, writes } = await start("Take it over here");
    expect(outcome).toBe("go");
    expect(writes.map((c) => c.args.takeOver)).toEqual([true]);
    const card = useKanban.getState().byWorkspace["ws-1"]?.cards.find((c) => c.id === "gh-issue-7");
    expect(card?.ghClaim?.device).toBe("dev-mini");
  });
});
