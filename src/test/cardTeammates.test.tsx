// N14 (items 4 and 6): on a GitHub-backed card, who described it when it
// was someone else ("<login> described the card"), and a teammate's pull
// request linked to its issue ("Pull request #23 by <login>"), which opens
// on GitHub — never taken for the card's own ship PR.
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import { CardDetailPanel } from "../components/CardDetailPanel";
import type { KanbanCard, LinkedPullRequest } from "../ipc";
import { useBuilder } from "../store/builderStore";
import { useIdentity } from "../store/identityStore";
import { useLicense } from "../store/licenseStore";
import { useUi } from "../store/uiStore";
import { BOARD_WS, boardCard, seedBoard } from "./boardFixtures";
import { act, renderUi, screen, waitFor, within } from "./render";
import { setTeamAllowed } from "./planGates";

vi.mock("../components/BuilderSession", () => ({
  BuilderSession: ({ cardId }: { cardId: string }) => {
    useEffect(() => {}, []);
    return <div data-testid={`terminal-${cardId}`} />;
  },
}));
vi.mock("../components/OutcomeScreen", () => ({
  OutcomeScreen: () => <div data-testid="outcome" />,
}));

const TEAMMATES_PR: LinkedPullRequest = {
  number: 23,
  url: "https://github.com/o/lyra/pull/23",
  state: "open",
  draft: false,
  author: "test-user",
};

function open(
  card: KanbanCard,
  linked: LinkedPullRequest[],
  login: string | null = "test-owner",
  allowed = true,
) {
  useLicense.setState({
    info: { status: "none", team: null, seats: null, issuedAt: null, expiresAt: null, teamRepo: null },
    loaded: true,
  } as never);
  setTeamAllowed(allowed);
  useIdentity.setState({ githubLogin: login, githubLoginAt: Date.now() });
  seedBoard([card], { kanbanSyncMode: "githubIssues", githubOwnerRepo: "o/lyra" } as never);
  useUi.setState({ selectedCardId: { [BOARD_WS]: card.id }, centerMode: { [BOARD_WS]: "board" } });
  useBuilder.setState({ byCard: {}, vendorPref: {}, trustAsking: {} });
  const view = renderUi(<CardDetailPanel workspaceId={BOARD_WS} />, {
    fixtures: {
      card_overlap_check: [],
      reviewer_list: [],
      verify_status: null,
      verify_list_inflight: [],
      improvement_proposal_state: null,
      improvement_proposal_trust_stopped: null,
      ship_pending_release: { release: null, unreadable: null },
      card_review_tip: null,
      worktree_env_proposal: [],
      kanban_card_linked_pull_requests: linked,
      open_web_link: null,
    },
  });
  view.tauri.allowUnhandled();
  return view;
}

const teamCard = (patch: Partial<KanbanCard> = {}) =>
  boardCard("gh-issue-21", {
    title: "Team: calcTriple",
    notes: "Add calcTriple.",
    ghIssueNumber: 21,
    ghAuthor: "test-user",
    ...patch,
  } as Partial<KanbanCard>);

describe("a teammate's issue and pull request on the card (N14)", () => {
  it("says who described the card and links the teammate's pull request", async () => {
    const view = open(teamCard(), [TEAMMATES_PR]);
    expect(await screen.findByText("test-user described the card")).toBeTruthy();
    const link = await screen.findByRole("button", { name: "Pull request #23 by test-user" });
    expect(screen.getByText("Linked pull request")).toBeTruthy();
    expect(view.tauri.callsOf("kanban_card_linked_pull_requests")[0].args).toMatchObject({
      workspaceId: BOARD_WS,
      cardId: "gh-issue-21",
    });
    act(() => link.click());
    await waitFor(() =>
      expect(view.tauri.callsOf("open_web_link")[0]?.args).toEqual({ url: "https://github.com/o/lyra/pull/23" }),
    );
  });

  it("keeps \"Opened as issue #N\" for my own issue, and shows no linked pull request when there is none", async () => {
    const view = open(teamCard({ ghAuthor: "test-owner" }), []);
    expect(await screen.findByText("Opened as issue #21")).toBeTruthy();
    await waitFor(() => expect(view.tauri.callsOf("kanban_card_linked_pull_requests")).toHaveLength(1));
    expect(screen.queryByText(/described the card/)).toBeNull();
    expect(screen.queryByText("Linked pull request")).toBeNull();
  });

  it("U28: Now names a teammate's open pull request on a card they hold", async () => {
    const view = open(teamCard({ ghAssignees: ["test-user"] }), [TEAMMATES_PR]);
    expect(await screen.findByText("Pull request #23 by test-user is open for this card.")).toBeTruthy();
    expect(view.tauri.callsOf("kanban_card_linked_pull_requests")).toHaveLength(1);
  });

  it("a closed card with a teammate's merged pull request says that, not \"no run on record\"", async () => {
    const closed = { columnId: "complete", lastRunStatus: null } as Partial<KanbanCard>;
    open(teamCard(closed), [{ ...TEAMMATES_PR, state: "merged" }]);
    expect(await screen.findByText("Pull request #23 by test-user was merged for this card.")).toBeTruthy();
    expect(screen.queryByText(/no run on record/)).toBeNull();
  });

  it("a closed card keeps \"no run on record\" with no merged pull request", async () => {
    const closed = { columnId: "complete", lastRunStatus: null } as Partial<KanbanCard>;
    const view = open(teamCard(closed), [{ ...TEAMMATES_PR, state: "closed" }]);
    await waitFor(() => expect(view.tauri.callsOf("kanban_card_linked_pull_requests")).toHaveLength(1));
    await screen.findByText("Linked pull request");
    expect(screen.getByText("It finished with no run on record.")).toBeTruthy();
    expect(screen.queryByText(/was merged for this card/)).toBeNull();
  });

  it("U8: Created by is the issue author's login, not this Mac's git email", async () => {
    open(teamCard({ author: "dev@example.com" }), []);
    const details = screen.getByText("Created by").closest("div")!;
    expect(details.textContent).toContain("test-user");
    expect(details.textContent).not.toContain("dev@example.com");
  });

  it("U8: a card with no issue keeps its own author", async () => {
    open(teamCard({ author: "dev@example.com", ghIssueNumber: null, ghAuthor: null }), []);
    expect(screen.getByText("Created by").closest("div")!.textContent).toContain("dev@example.com");
  });

  it("U3: the card's ⋯ offers Claim", async () => {
    const view = open(teamCard({ ghAuthor: "test-owner" }), []);
    await screen.findByText("Opened as issue #21");
    await view.user.click(screen.getByRole("button", { name: "More for this card" }));
    const menu = await screen.findByRole("menu", { name: "More for this card" });
    expect(within(menu).getByRole("menuitem", { name: "Claim" })).toBeTruthy();
  });

  it("reads nothing for a card with no issue", async () => {
    const view = open(teamCard({ ghIssueNumber: null, ghAuthor: null }), [TEAMMATES_PR]);
    await new Promise((r) => setTimeout(r, 30));
    expect(view.tauri.callsOf("kanban_card_linked_pull_requests")).toHaveLength(0);
    expect(screen.queryByText(/Pull request #23/)).toBeNull();
  });

  it("asks nothing without the team permission (Reviewer P3-2)", async () => {
    const view = open(teamCard(), [TEAMMATES_PR], "test-owner", false);
    await new Promise((r) => setTimeout(r, 30));
    expect(view.tauri.callsOf("kanban_card_linked_pull_requests")).toHaveLength(0);
    expect(screen.queryByText(/Pull request #23/)).toBeNull();
  });
});
