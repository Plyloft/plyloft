// Team walk 2026-10-02 (C3): the question before claiming a card someone else
// holds defaults to the safe answer — Cancel has focus, "Claim it too" is not
// the highlighted button — and names the card's open pull request.
import { describe, expect, it } from "vitest";
import { KanbanBoard } from "../components/KanbanBoard";
import { useIdentity } from "../store/identityStore";
import { useKanban } from "../store/kanbanStore";
import { act, renderUi, screen, waitFor, within } from "./render";
import { boardCard, seedBoard } from "./boardFixtures";

describe("Claim on a card someone else holds (C3)", () => {
  it("asks with Cancel as the default, and names the open pull request", async () => {
    const card = boardCard("gh-issue-21", {
      ghIssueNumber: 21,
      ghAssignees: ["teammate"],
      pr: { number: 23, state: "open" } as never,
    });
    act(() => seedBoard([card], { kanbanSyncMode: "githubIssues" } as never));
    const { user, tauri } = renderUi(<div />, {
      fixtures: {
        kanban_card_claim: () => ({
          claimed: false,
          holder: { kind: "others", logins: ["teammate"] },
          card,
        }),
      },
    });
    tauri.allowUnhandled();
    let done = false;
    void useKanban
      .getState()
      .claimCard("ws-1", "gh-issue-21")
      .then(() => (done = true));
    const sheet = await screen.findByRole("dialog", {
      name: "Already claimed by teammate. Claim it too?",
    });
    expect(sheet.textContent).toContain("Pull request #23 is already open for it.");
    const cancel = within(sheet).getByRole("button", { name: "Cancel" });
    await waitFor(() => expect(document.activeElement).toBe(cancel));
    const claim = within(sheet).getByRole("button", { name: "Claim it too" });
    expect(claim.className).not.toContain("cbtn--accent");
    await user.click(cancel);
    await waitFor(() => expect(done).toBe(true));
    expect(tauri.callsOf("kanban_card_claim")).toHaveLength(1);
  });
});

// 1.175.0 (D1, mockup two-people.html#d1): two people press Start build on
// the same card within seconds. The second is told, with the focus on
// leaving it; nothing started and their name is off the issue again.
describe("Start build a moment after a teammate (D1)", () => {
  const card = boardCard("gh-issue-161", { title: "Fix login redirect", ghIssueNumber: 161, ghAssignees: [] });
  const TITLE = "example-teammate started this a moment ago";
  const HINT = "Claiming it too means two people may build the same thing.";

  const press = (nameOff: boolean) => {
    act(() => {
      useIdentity.setState({ githubLogin: "matteo", githubLoginAt: Date.now() });
      seedBoard([card], { kanbanSyncMode: "githubIssues", githubOwnerRepo: "o/r" } as never);
    });
    const theirs = { ...card, ghAssignees: nameOff ? ["example-teammate"] : ["example-teammate", "matteo"] };
    const view = renderUi(<div />, {
      fixtures: {
        kanban_card_claim_state: () => ({ claimed: false, holder: { kind: "unclaimed" }, card }),
        kanban_card_claim: (args: Record<string, unknown>) =>
          args.confirmed
            ? { claimed: true, holder: { kind: "others", logins: ["example-teammate"] }, card: { ...card, ghAssignees: ["example-teammate", "matteo"] } }
            : {
                claimed: false,
                holder: { kind: "others", logins: ["example-teammate"] },
                card: theirs,
                raced: { first: "example-teammate", nameOff },
              },
        kanban_card_device_claim: () => card,
        open_web_link: null,
      },
    });
    view.tauri.allowUnhandled();
    const result: { outcome: string | null } = { outcome: null };
    void useKanban
      .getState()
      .claimBeforeBuild("ws-1", "gh-issue-161")
      .then((o) => (result.outcome = o));
    return { ...view, result };
  };

  it("says who started it, that nothing started here and that the name is off; the focus is on leaving it", async () => {
    const { user, tauri, result } = press(true);
    const sheet = await screen.findByRole("dialog", { name: TITLE });
    expect(sheet.textContent).toContain(
      "You both pressed Start build on “Fix login redirect” (#161) at almost the same time. Nothing was started here, and your name is off the issue again.",
    );
    expect(sheet.querySelector(".ux-sheet-hint")?.textContent).toBe(HINT);
    const leave = within(sheet).getByRole("button", { name: "Leave it to example-teammate" });
    await waitFor(() => expect(document.activeElement).toBe(leave));
    expect(leave.className).toContain("cbtn--strong");
    const too = within(sheet).getByRole("button", { name: "Claim it too" });
    expect(too.className).not.toContain("cbtn--accent");
    expect(within(sheet).queryByRole("button", { name: "Open on GitHub" })).toBeNull();
    // Not the second-claim question: this one says what just happened.
    expect(screen.queryByText(/Already claimed by/)).toBeNull();
    await user.click(leave);
    await waitFor(() => expect(result.outcome).toBe("cancel"));
    // Leaving it writes nothing more: the name was already taken off.
    expect(tauri.callsOf("kanban_card_claim")).toHaveLength(1);
    expect(tauri.callsOf("kanban_card_device_claim")).toHaveLength(0);
  });

  it("Claim it too puts the name back and lets the build start", async () => {
    const { user, tauri, result } = press(true);
    const sheet = await screen.findByRole("dialog", { name: TITLE });
    await user.click(within(sheet).getByRole("button", { name: "Claim it too" }));
    await waitFor(() => expect(result.outcome).toBe("claimed"));
    expect(tauri.callsOf("kanban_card_claim").map((c) => c.args.confirmed)).toEqual([false, true]);
  });

  it("GitHub didn't take the name off: the sheet says the issue lists both, and opens it on GitHub", async () => {
    const { user, tauri, result } = press(false);
    const sheet = await screen.findByRole("dialog", { name: TITLE });
    expect(sheet.textContent).toContain(
      "Nothing was started here. GitHub didn't take your name off the issue, so it lists you both: take it off on GitHub, or claim it too.",
    );
    expect(within(sheet).getAllByRole("button").map((b) => b.textContent)).toEqual(
      expect.arrayContaining(["Leave it to example-teammate", "Open on GitHub", "Claim it too"]),
    );
    const labels = within(sheet).getAllByRole("button").map((b) => b.textContent);
    expect(labels.indexOf("Leave it to example-teammate")).toBeLessThan(labels.indexOf("Open on GitHub"));
    expect(labels.indexOf("Open on GitHub")).toBeLessThan(labels.indexOf("Claim it too"));
    await user.click(within(sheet).getByRole("button", { name: "Open on GitHub" }));
    await waitFor(() => expect(result.outcome).toBe("cancel"));
    expect(tauri.callsOf("open_web_link").map((c) => c.args.url)).toEqual(["https://github.com/o/r/issues/161"]);
    expect(tauri.callsOf("kanban_card_claim")).toHaveLength(1);
  });

  it("a card both hold says both names: in the state's place before it starts, on a quiet line once it runs", () => {
    act(() => {
      useIdentity.setState({ githubLogin: "matteo", githubLoginAt: Date.now() });
      seedBoard(
        [
          boardCard("gh-issue-1", { ghIssueNumber: 1, ghAssignees: ["matteo", "example-teammate"] }),
          boardCard("gh-issue-2", {
            ghIssueNumber: 2,
            ghAssignees: ["example-teammate", "matteo"],
            columnId: "in_progress",
            worktreePath: "/w/2",
            lastRunStatus: "running",
          }),
          boardCard("gh-issue-3", { ghIssueNumber: 3, ghAssignees: ["matteo"], columnId: "in_progress", worktreePath: "/w/3" }),
        ],
        { kanbanSyncMode: "githubIssues" } as never,
      );
    });
    renderUi(<KanbanBoard workspaceId="ws-1" />).tauri.allowUnhandled();
    const tile = (id: string) => document.querySelector(`[data-board-card-id="${id}"]`)!;
    const shared = (id: string) => tile(id).querySelector("[data-ply-board-card-shared-claim]")?.textContent ?? null;
    expect(tile("gh-issue-1").textContent).toContain("Claimed by you and example-teammate");
    expect(shared("gh-issue-1")).toBeNull();
    expect(shared("gh-issue-2")).toBe("Claimed by you and example-teammate");
    expect(shared("gh-issue-3")).toBeNull();
    expect(tile("gh-issue-3").textContent).not.toContain("Claimed by you");
  });
});
