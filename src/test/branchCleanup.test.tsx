// N18: card branches are cleaned up automatically. What the person sees and
// answers: the Inbox ask for archived cards' branches (Delete them / Keep
// them), the one-time offer for branches of cards that shipped before
// (Delete N branches / Not now / Never), and the switch and the kept branches
// in Settings › Shipping › Card branches (1.174.0). The card's Activity row is in
// cardPage.test.tsx.
import { afterEach, describe, expect, it } from "vitest";
import { InboxPanel } from "../components/InboxPanel";
import { WorktreesPage } from "../components/settings/WorktreesPage";
import { ShippingPage } from "../components/settings/ShippingPage";
import { useWorkspaces, type Workspace } from "../store/workspaceStore";
import { useKanban } from "../store/kanbanStore";
import {
  startBranchCleanupSubscriptions,
  stopBranchCleanupSubscriptionsForTests,
  useBranchCleanup,
} from "../store/branchCleanupStore";
import { WorkspaceSidebar } from "../components/WorkspaceSidebar";
import { useInbox } from "../store/inboxStore";
import type { InboxFeed, KanbanCard, PendingBranchCleanup } from "../ipc";
import { act, nextFrame, renderUi, screen, tauri, waitFor, within } from "./render";

const NOW = Date.now();

const lyra: Workspace = {
  id: "l",
  name: "Lyra",
  cwd: "/Users/someone/code/lyra",
  createdAt: 1,
  lastOpenedAt: 1,
  openFiles: [],
  activeFile: null,
  githubOwnerRepo: "acme/lyra",
};

const emptyFeed: InboxFeed = {
  generatedAt: NOW,
  windowDays: 28,
  events: [],
  costRollup: [],
  eligibilityProof: {} as InboxFeed["eligibilityProof"],
};

const pending: PendingBranchCleanup[] = [
  {
    workspaceId: "l",
    workspaceName: "Lyra",
    asks: [
      { cardId: "a1", title: "Old idea", branch: "plyloft/card-a1-old-idea", at: NOW - 2 * 3_600_000 },
      { cardId: "a2", title: "Spike", branch: "plyloft/card-a2-spike", at: NOW - 3 * 3_600_000 },
    ],
    backlogAt: NOW - 5 * 60_000,
    backlog: [
      { cardId: "s1", title: "Header", branch: "plyloft/card-s1-header", tip: "t1", archived: false, since: 1 },
      { cardId: "s2", title: "Footer", branch: "atelier/card-s2-footer", tip: "t2", archived: false, since: 1 },
      { cardId: "x1", title: "Dropped", branch: "plyloft/card-x1-dropped", tip: "t3", archived: true, since: 1 },
    ],
  },
];

function seed(ws: Workspace = lyra) {
  act(() => useWorkspaces.setState({ workspaces: [ws], activeId: ws.id }));
}

/** A5 (A0): a row's other answers are in its ⋯. */
async function moreItem(r: { user: { click: (el: Element) => Promise<void> } }, row: string, item: string) {
  await r.user.click(await screen.findByRole("button", { name: `More for ${row}` }));
  await r.user.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: item }));
}

describe("N18: the Inbox asks about card branches", () => {
  it("lists the archived cards' branches and the old ones, and counts them as needing you", async () => {
    seed();
    renderUi(<InboxPanel />, {
      fixtures: { inbox_feed: emptyFeed, branch_cleanup_pending: () => pending },
    });
    expect(await screen.findByText("2 archived cards' work is only on their branches")).toBeTruthy();
    expect(
      screen.getByText(
        "Their cards were archived without shipping, so the work is only on these branches, not on the main branch: plyloft/card-a1-old-idea and plyloft/card-a2-spike",
      ),
    ).toBeTruthy();
    // Each row says when, like every Inbox row.
    const askRow = screen.getByText("2 archived cards' work is only on their branches").closest(".ux-row")!;
    expect(askRow.querySelector(".ux-inbox-when")?.textContent).toBe("2h");
    expect(screen.getByText("2 branches of cards that already shipped can be deleted")).toBeTruthy();
    expect(
      screen.getByText(
        "plyloft/card-s1-header and atelier/card-s2-footer · 1 archived card's branch will be asked about here",
      ),
    ).toBeTruthy();
    expect(screen.getByText("2 things need you.")).toBeTruthy();
    // N19: the ask's long sentence is the row's tooltip and describes its
    // Keep them / Delete them…, so it is never only cut short on screen.
    const askLine = screen.getByText(/^Their cards were archived without shipping/);
    expect(askLine.getAttribute("title")).toBe(askLine.textContent);
    expect(within(askRow as HTMLElement).getByRole("button", { name: "Keep them" }).getAttribute("aria-describedby")).toBe(askLine.id);
    const needs = screen.getByRole("group", { name: "Needs you" });
    // 1.171.0 A3 (BI-2): Keep them first; Delete them… asks. 1.174.0 (A5,
    // A0): one action a row, its other answers in the row's ⋯.
    expect(within(needs).getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual([
      "Keep them",
      "More for 2 archived cards' work is only on their branches",
      "Delete 2 branches",
      "More for 2 branches of cards that already shipped can be deleted",
    ]);
  });

  it("Keep them and Delete them… answer for exactly the cards listed; Delete asks first", async () => {
    seed();
    let left = pending;
    const r = renderUi(<InboxPanel />, {
      fixtures: {
        inbox_feed: emptyFeed,
        branch_cleanup_pending: () => left,
        branch_cleanup_answer: () => {
          left = [{ ...pending[0], asks: [] }];
          return { deleted: 0, kept: 2, queued: 0 };
        },
      },
    });
    await r.user.click(await screen.findByRole("button", { name: "Keep them" }));
    await waitFor(() => expect(r.tauri.callsOf("branch_cleanup_answer")).toHaveLength(1));
    expect(r.tauri.callsOf("branch_cleanup_answer")[0].args).toEqual({
      workspaceId: "l",
      cardIds: ["a1", "a2"],
      delete: false,
    });
    await waitFor(() => expect(screen.queryByText(/archived cards' work is only/)).toBeNull());

    left = pending;
    await act(() => useBranchCleanup.getState().refresh());
    await moreItem(r, "2 archived cards' work is only on their branches", "Delete them…");
    const sheet = await screen.findByRole("dialog", { name: "Delete these 2 branches?" });
    // Keep them in the sheet deletes nothing.
    await r.user.click(within(sheet).getByRole("button", { name: "Keep them" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Delete these 2 branches?" })).toBeNull());
    expect(r.tauri.callsOf("branch_cleanup_answer")).toHaveLength(1);
    await moreItem(r, "2 archived cards' work is only on their branches", "Delete them…");
    const again = await screen.findByRole("dialog", { name: "Delete these 2 branches?" });
    await r.user.click(within(again).getByRole("button", { name: "Delete them" }));
    await waitFor(() => expect(r.tauri.callsOf("branch_cleanup_answer")).toHaveLength(2));
    expect(r.tauri.callsOf("branch_cleanup_answer")[1].args).toMatchObject({ delete: true, cardIds: ["a1", "a2"] });
  });

  it("the old branches' offer: Delete N branches, Not now and Never each answer once", async () => {
    seed();
    const r = renderUi(<InboxPanel />, {
      fixtures: {
        inbox_feed: emptyFeed,
        branch_cleanup_pending: () => pending,
        branch_backlog_answer: () => ({ deleted: 2, kept: 0, queued: 1 }),
      },
    });
    await r.user.click(await screen.findByRole("button", { name: "Delete 2 branches" }));
    await waitFor(() => expect(r.tauri.callsOf("branch_backlog_answer")).toHaveLength(1));
    expect(r.tauri.callsOf("branch_backlog_answer")[0].args).toEqual({ workspaceId: "l", answer: "delete" });
    await moreItem(r, "2 branches of cards that already shipped can be deleted", "Not now");
    await waitFor(() => expect(r.tauri.callsOf("branch_backlog_answer")).toHaveLength(2));
    expect(r.tauri.callsOf("branch_backlog_answer")[1].args).toMatchObject({ answer: "notNow" });
    await moreItem(r, "2 branches of cards that already shipped can be deleted", "Never");
    await waitFor(() => expect(r.tauri.callsOf("branch_backlog_answer")).toHaveLength(3));
    expect(r.tauri.callsOf("branch_backlog_answer")[2].args).toMatchObject({ answer: "never" });
  });

  it("shows nothing when nothing is pending", async () => {
    seed();
    renderUi(<InboxPanel />, { fixtures: { inbox_feed: emptyFeed, branch_cleanup_pending: () => [] } });
    // 1.173.0 (F1, BI-13): the empty Inbox.
    expect(await screen.findByText("Nothing needs you")).toBeTruthy();
    expect(screen.queryByText(/branch/)).toBeNull();
  });
});

// 1.174.0 (DS2, SL-3): the branches the cleanup kept, and GitHub's own
// setting, are in Settings › Shipping › Card branches › Kept after shipping.
describe("N18: Settings › Shipping › Kept after shipping", () => {
  const kept = {
    id: "k1",
    workspaceId: "l",
    title: "Tidy the header",
    columnId: "complete",
    branchCleanup: { branch: "plyloft/card-k1-tidy", tip: "abc", reason: "shipped", since: 1, outcome: "movedOn" },
  } as unknown as KanbanCard;
  const gone = { ...kept, id: "k2", title: "Gone one", branchCleanup: { ...kept.branchCleanup!, outcome: "deleted" } } as KanbanCard;

  async function openKept(ws: Workspace = lyra, fixtures: Record<string, unknown> = {}) {
    seed(ws);
    act(() =>
      useKanban.setState((s) => ({
        byWorkspace: { ...s.byWorkspace, l: { cards: [kept, gone], loaded: true } as never },
      })),
    );
    const r = renderUi(<ShippingPage workspaceId="l" />, {
      fixtures: {
        workspace_definition_get: null,
        project_config_get: null,
        project_review_get: { selfCheck: true, reviewChecklist: [] },
        worktree_settings_get: {},
        areas_get: null,
        areas_releases: [],
        deploy_map_get: {
          repo: "acme/lyra",
          railway: { state: "noCli", project: null, services: [], message: null, readAt: null },
          workflows: [],
        },
        ...fixtures,
      },
    });
    r.tauri.allowUnhandled();
    expect(
      await screen.findByText(
        "1 branch with commits made after it shipped. On GitHub, Plyloft deletes only a card's own branch, once its pull request merged.",
      ),
    ).toBeTruthy();
    await r.user.click(screen.getByRole("button", { name: "Show 1" }));
    return r;
  }

  it("lists a branch kept for commits after it shipped, its name behind ⋯", async () => {
    const r = await openKept();
    expect(await screen.findByText("Tidy the header")).toBeTruthy();
    expect(screen.getByText("Has commits after it shipped — kept")).toBeTruthy();
    expect(screen.queryByText("Gone one")).toBeNull();
    expect(document.body.textContent).not.toContain("plyloft/card-k1-tidy");
    await r.user.click(screen.getByRole("button", { name: "More for plyloft/card-k1-tidy" }));
    expect(screen.getByRole("menuitem", { name: "Copy the branch name" })).toBeTruthy();
  });

  it("keeps the GitHub suggestion, with a link to the repository's settings", async () => {
    const r = await openKept(lyra, { open_web_link: () => undefined });
    expect(await screen.findByText(/turn on “Automatically delete head branches” in the repository's settings/)).toBeTruthy();
    // 1.171.0 A3 (FR-12): since G5 a card's own branch on GitHub goes too.
    expect(screen.getByText(/On GitHub, Plyloft deletes only a card's own branch, once its pull request merged\./)).toBeTruthy();
    expect(screen.queryByText(/never on GitHub/)).toBeNull();
    await r.user.click(screen.getByRole("button", { name: "Open the repository's settings" }));
    await waitFor(() => expect(r.tauri.callsOf("open_web_link")).toHaveLength(1));
    expect(r.tauri.callsOf("open_web_link")[0].args).toEqual({ url: "https://github.com/acme/lyra/settings" });
  });

  it("without a known repository, the suggestion has no link", async () => {
    await openKept({ ...lyra, githubOwnerRepo: null });
    expect(await screen.findByText(/Automatically delete head branches/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open the repository's settings" })).toBeNull();
  });

  it("a local board links to its GitHub origin's settings", async () => {
    const r = await openKept(
      { ...lyra, githubOwnerRepo: null },
      {
        project_local_origin: () => ({ hasOrigin: true, defaultBranch: "main", githubRepo: "acme/origin" }),
        open_web_link: () => undefined,
      },
    );
    await r.user.click(await screen.findByRole("button", { name: "Open the repository's settings" }));
    await waitFor(() => expect(r.tauri.callsOf("open_web_link")).toHaveLength(1));
    expect(r.tauri.callsOf("open_web_link")[0].args).toEqual({ url: "https://github.com/acme/origin/settings" });
  });

  it("Cards' copies no longer draws them", async () => {
    seed();
    const r = renderUi(<WorktreesPage scope="repository" workspaceId="l" />, {
      fixtures: { worktree_list: () => [], worktree_kept_list: () => [], local_branch_status: () => null },
    });
    r.tauri.allowUnhandled();
    await screen.findByText("Read them again");
    expect(screen.queryByText(/Automatically delete head branches/)).toBeNull();
  });
});

describe("N18 (M3): the sidebar counts the asks without the Inbox open", () => {
  afterEach(() => stopBranchCleanupSubscriptionsForTests());

  it("reads them at startup and again when a board changes", async () => {
    seed();
    let answer: PendingBranchCleanup[] = [];
    tauri().allowUnhandled();
    tauri().fixture("branch_cleanup_pending", () => answer);
    tauri().fixture("drain_status", { draining: false, startedAt: null });
    tauri().fixture("ship_pending_count", 0);
    tauri().fixture("ship_pending_cards", null);
    tauri().fixture("ship_unverified_count", 0);
    act(() => useInbox.setState({ feed: emptyFeed }));
    renderUi(<WorkspaceSidebar env={null} />);
    act(() => startBranchCleanupSubscriptions());
    await nextFrame();
    expect(tauri().callsOf("branch_cleanup_pending").length).toBeGreaterThan(0);
    const inbox = () => screen.getByRole("button", { name: /^Inbox/ });
    expect(within(inbox()).queryByText("2")).toBeNull();

    answer = pending;
    act(() => tauri().emit("kanban://changed", "l"));
    await waitFor(() => expect(within(inbox()).getByText("2")).toBeTruthy(), { timeout: 3000 });
  });
});
