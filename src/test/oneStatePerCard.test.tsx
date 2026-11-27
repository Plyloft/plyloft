// UX P1 point 2 (P-A): one state function for every surface. The same card
// says the same word, from the same rule, on the Board, its page, the List,
// a dependent's blocker chip and the Inbox — and the app tester's tree reads
// that rule (`data-ply-rule`) next to each surface's name.
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import { CardDetailPanel } from "../components/CardDetailPanel";
import { KanbanBoard } from "../components/KanbanBoard";
import { InboxPanel } from "../components/InboxPanel";
import type { InboxEvent, InboxFeed, KanbanCard } from "../ipc";
import { useUi } from "../store/uiStore";
import { useBoard } from "../store/boardStore";
import { useCardFacts } from "../store/cardFactsStore";
import { useBuilder } from "../store/builderStore";
import { useBuilderWaiting } from "../store/builderWaitingStore";
import { useInbox } from "../store/inboxStore";
import { waitingSessions } from "../lib/needsYou";
import { observeShipAttempt, useErrorBlocks } from "../store/errorBlockStore";
import type { LocalBranchRefused } from "../ipc";
import { useWorkspaces } from "../store/workspaceStore";
import { buildTree, flatten } from "../testBridge/tree";
import { BOARD_WS, boardCard, seedBoard } from "./boardFixtures";
import { act, renderUi, screen, tauri, waitFor, within } from "./render";

vi.mock("../components/BuilderSession", () => ({
  BuilderSession: ({ cardId }: { cardId: string }) => {
    useEffect(() => {}, []);
    return <div data-testid={`terminal-${cardId}`} />;
  },
}));
vi.mock("../components/OutcomeScreen", () => ({
  OutcomeScreen: () => <div data-testid="outcome" />,
}));

const PAGE_FIXTURES = {
  card_overlap_check: [],
  reviewer_list: [],
  verify_status: null,
  verify_list_inflight: [],
  improvement_proposal_state: null,
  improvement_proposal_trust_stopped: null,
  ship_pending_release: { release: null, unreadable: null },
  card_review_tip: null,
  worktree_env_proposal: [],
};

function shippable(id: string, patch: Partial<KanbanCard> = {}): KanbanCard {
  return boardCard(id, {
    title: `Card ${id}`,
    notes: "Do it",
    columnId: "complete",
    lastRunStatus: "success",
    verifyStatus: "passed",
    worktreePath: `/tmp/wt/${id}`,
    branchName: `atelier/card-${id}`,
    ...patch,
  } as Partial<KanbanCard>);
}

function boardWord(id: string): { text: string; rule: string | null } {
  const el = document.querySelector(`[data-ply-board-card-id="${id}"]`) as HTMLElement;
  return { text: el.querySelector(".board-card-fact")?.textContent ?? "", rule: el.getAttribute("data-ply-rule") };
}

function feedOf(events: InboxEvent[]): InboxFeed {
  return { generatedAt: Date.now(), windowDays: 14, events, costRollup: [], eligibilityProof: {} as never, cardSeen: {} };
}

function row(card: KanbanCard, over: Partial<InboxEvent>): InboxEvent {
  return {
    id: `review:${card.id}:manual`,
    kind: "review_needed",
    group: "needs_you",
    workspaceId: BOARD_WS,
    workspaceName: "Board",
    cardId: card.id,
    runId: null,
    title: card.title,
    detail: null,
    url: null,
    at: Date.now() - 60_000,
    seenAt: null,
    seenEligible: true,
    ...over,
  };
}

describe("one state for every surface (UX P1 point 2)", () => {
  it("a ship stopped on a conflict says so on the Board, its page and the Inbox — never 'Preparing the result'", async () => {
    const card = shippable("c1", { reviewStatus: "conflict_blocked" });
    act(() => seedBoard([card]));
    const board = renderUi(<KanbanBoard workspaceId={BOARD_WS} />, { fixtures: { card_review_tip: null } });
    expect(boardWord("c1")).toEqual({ text: "Ship stopped on a conflict", rule: "ship-conflict" });
    // The tester's tree reads the rule beside the Board card's name.
    const nodes = flatten(buildTree(document.body, { layout: false, terminals: { at: () => null }, maxNodes: 2000 }).nodes);
    const node = nodes.find((n) => n.name.startsWith("Card c1"));
    expect(node?.states).toContain("rule=ship-conflict");
    board.unmount();

    useUi.setState({ selectedCardId: { [BOARD_WS]: card.id }, centerMode: { [BOARD_WS]: "board" } });
    const page = renderUi(<CardDetailPanel workspaceId={BOARD_WS} />, {
      fixtures: { ...PAGE_FIXTURES, kanban_load: () => [card] },
    });
    page.tauri.allowUnhandled();
    const now = screen.getByRole("region", { name: "Now" });
    expect(now.getAttribute("data-ply-rule")).toBe("ship-conflict");
    expect(within(now).getByText("Ship stopped on a conflict")).toBeTruthy();
    // P-E: what is true, and (no Builder on this card) how by hand.
    expect(
      within(now).getByText("The last ship stopped on a conflict. Nothing was merged. Resolve it in the card's copy, then ship again."),
    ).toBeTruthy();
    expect(screen.queryByText("Preparing the result")).toBeNull();
    page.unmount();

    act(() =>
      useWorkspaces.setState({
        workspaces: [{ id: BOARD_WS, name: "Board", cwd: "/tmp/b", createdAt: 1, lastOpenedAt: 1, openFiles: [], activeFile: null }],
        activeId: BOARD_WS,
      }),
    );
    tauri().fixture("branch_cleanup_pending", []);
    renderUi(<InboxPanel />, {
      fixtures: {
        inbox_feed: feedOf([row(card, { id: "conflict:c1:manual", detail: "ship stopped on a conflict" })]),
      },
    });
    const needs = await screen.findByRole("group", { name: "Needs you" });
    expect(within(needs).getByText("Ship stopped on a conflict")).toBeTruthy();
    // 1.173.0 (F1): the Board card's own press.
    expect(within(needs).getByRole("button", { name: "Ship again" }).getAttribute("data-ply-rule")).toBe("ship-conflict");
  });

  it("a ship press that failed on the card page is what the Board and the Inbox say too", async () => {
    const card = shippable("c2");
    act(() => seedBoard([card]));
    act(() =>
      useWorkspaces.setState({
        workspaces: [{ id: BOARD_WS, name: "Board", cwd: "/tmp/b", createdAt: 1, lastOpenedAt: 1, openFiles: [], activeFile: null }],
        activeId: BOARD_WS,
      }),
    );
    // What the card page writes: the result it read, then its Ship it failing.
    act(() => {
      useCardFacts.getState().setOutcome(card, {
        loading: false,
        filesChanged: 2,
        shipBusy: false,
        noRemote: false,
        reviewFreshness: "none",
      });
      useCardFacts.getState().setShipFailure(card, "ship-it");
    });
    const board = renderUi(<KanbanBoard workspaceId={BOARD_WS} />, { fixtures: { card_review_tip: null } });
    expect(boardWord("c2")).toEqual({ text: "Ship didn't go through", rule: "ship-failed" });
    board.unmount();

    tauri().fixture("branch_cleanup_pending", []);
    renderUi(<InboxPanel />, { fixtures: { inbox_feed: feedOf([row(card, {})]) } });
    const needs = await screen.findByRole("group", { name: "Needs you" });
    expect(within(needs).getByText("Ship didn't go through")).toBeTruthy();
    expect(within(needs).queryByText(/Ready to ship/)).toBeNull();
    expect(within(needs).queryByRole("button", { name: "Ship it" })).toBeNull();
    // The page forgets it on another card, and so does every surface.
    act(() => useCardFacts.getState().setShipFailure(card, null));
    await waitFor(() => expect(within(screen.getByRole("group", { name: "Needs you" })).queryByText("Ship didn't go through")).toBeNull());
  });

  it("the Board's filter offers the words the cards say", async () => {
    const conflict = shippable("c3", { reviewStatus: "conflict_blocked" });
    const ready = shippable("c4");
    act(() => seedBoard([conflict, ready]));
    const { user } = renderUi(<KanbanBoard workspaceId={BOARD_WS} />, { fixtures: { card_review_tip: null } });
    await user.click(screen.getByRole("button", { name: /^Filter/ }));
    const words = screen.getAllByRole("checkbox").map((b) => b.closest("label")?.textContent ?? "");
    expect(words).toContain("Ship stopped on a conflict");
    expect(words).toContain("Ready to ship");
    // Filtering by a word shows exactly the cards that say it.
    await user.click(screen.getByRole("checkbox", { name: "Ship stopped on a conflict" }));
    expect(useBoard.getState().filter[BOARD_WS]?.states).toEqual(["Ship stopped on a conflict"]);
    expect(document.querySelector('[data-ply-board-card-id="c3"]')).toBeTruthy();
    expect(document.querySelector('[data-ply-board-card-id="c4"]')).toBeNull();
  });

  // 1.173.0 (F1, BI-14): no Mark all seen — a card row the Inbox added (a
  // failed Ship press Rust never saw) is to do, counted with Rust's rows,
  // until it is resolved; there is nothing to clear while there is no news.
  it("(F1) a card row the Inbox added stays and counts with Rust's; nothing marks it away", async () => {
    const card = shippable("c5");
    const other = shippable("c6");
    act(() => seedBoard([card, other]));
    act(() =>
      useWorkspaces.setState({
        workspaces: [{ id: BOARD_WS, name: "Board", cwd: "/tmp/b", createdAt: 1, lastOpenedAt: 1, openFiles: [], activeFile: null }],
        activeId: BOARD_WS,
      }),
    );
    // A failed Ship press on c5 (no Rust row); c6 has Rust's row.
    act(() => {
      useCardFacts.getState().setOutcome(card, {
        loading: false,
        filesChanged: 2,
        shipBusy: false,
        noRemote: false,
        reviewFreshness: "none",
      });
      useCardFacts.getState().setShipFailure(card, "ship-it");
    });
    tauri().fixture("branch_cleanup_pending", []);
    renderUi(<InboxPanel />, { fixtures: { inbox_feed: feedOf([row(other, { seenAt: Date.now() - 1000 })]) } });
    const needs = await screen.findByRole("group", { name: "Needs you" });
    expect(within(needs).getByText("Ship didn't go through")).toBeTruthy();
    expect(within(needs).getByText("Ready to ship")).toBeTruthy();
    expect(screen.getByText("2 things need you.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Mark all seen" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Clear the news" })).toBeNull();
    act(() => useCardFacts.getState().setShipFailure(card, null));
  });

  it("(Reviewer) the card page leaving a card forgets a ship under way: no stale 'Shipping' on the Board", () => {
    const card = shippable("c7");
    act(() => seedBoard([card]));
    act(() =>
      useCardFacts.getState().setOutcome(card, {
        loading: false,
        filesChanged: 2,
        shipBusy: true,
        noRemote: false,
        reviewFreshness: "none",
      }),
    );
    const board = renderUi(<KanbanBoard workspaceId={BOARD_WS} />, { fixtures: { card_review_tip: null } });
    expect(boardWord("c7").text).toBe("Shipping");
    act(() => useCardFacts.getState().leave(card));
    expect(boardWord("c7").text).toBe("Ready to ship");
    board.unmount();
  });

  // 1.173.0 (F1, Challenger 5): its row says what its Board card says — the
  // headline and the Board's press (See the review, its result not read
  // yet), never Ship it where the Board doesn't offer it.
  it("(Mac walk 2) an approved Builder card still in In progress is Ready to ship in the Inbox with its Board press", async () => {
    const card = boardCard("c8", {
      title: "Card c8",
      notes: "Do it",
      columnId: "in_progress",
      lastRunStatus: "success",
      verifyStatus: "passed",
      verifyHistory: [{ status: "passed", steps: [] } as never],
      worktreePath: "/tmp/wt/c8",
      branchName: "atelier/card-c8",
      builder: {
        vendor: "claude",
        bypass: false,
        ptyId: "pty-8",
        sessionLost: false,
        startedAt: Date.now() - 60_000,
        snapshots: [{ n: 1, sha: "aaaaaaaa1", at: Date.now() - 30_000 }],
        review: { snapshotN: 1, provider: "codex", degraded: false, status: "done", verdict: "approve", at: Date.now() - 1000 },
      },
    } as Partial<KanbanCard>);
    act(() => seedBoard([card]));
    act(() =>
      useWorkspaces.setState({
        workspaces: [{ id: BOARD_WS, name: "Board", cwd: "/tmp/b", createdAt: 1, lastOpenedAt: 1, openFiles: [], activeFile: null }],
        activeId: BOARD_WS,
      }),
    );
    tauri().fixture("branch_cleanup_pending", []);
    renderUi(<InboxPanel />, {
      fixtures: {
        // Rust's row: "The work is done · review it" (it ships only Complete cards).
        inbox_feed: feedOf([row(card, {})]),
        card_review_tip: { branchTip: "aaaaaaaa1", commitsSinceReview: 0 },
      },
    });
    const needs = await screen.findByRole("group", { name: "Needs you" });
    await waitFor(() => expect(within(needs).getByText("Ready to ship")).toBeTruthy());
    expect(within(needs).queryByText("The work is done · review it")).toBeNull();
    expect(within(needs).queryByRole("button", { name: "Ship it" })).toBeNull();
    const press = within(needs).getByRole("button", { name: "See the review" });
    expect(press.getAttribute("data-ply-rule")).toBe("base");
  });

  it("(Mac walk 5) a ship stopped on a conflict has the Board card's amber dot in the Inbox, not a green one", async () => {
    const card = shippable("c9", { reviewStatus: "conflict_blocked" });
    act(() => seedBoard([card]));
    act(() =>
      useWorkspaces.setState({
        workspaces: [{ id: BOARD_WS, name: "Board", cwd: "/tmp/b", createdAt: 1, lastOpenedAt: 1, openFiles: [], activeFile: null }],
        activeId: BOARD_WS,
      }),
    );
    tauri().fixture("branch_cleanup_pending", []);
    // Mac walk 2: the row the card had before the ship (Rust's "review it")
    // says the conflict at once.
    renderUi(<InboxPanel />, { fixtures: { inbox_feed: feedOf([row(card, {})]) } });
    const needs = await screen.findByRole("group", { name: "Needs you" });
    const word = within(needs).getByText("Ship stopped on a conflict");
    const r = word.closest(".ux-row") as HTMLElement;
    expect(r.querySelector(".ux-state-dot--aborted")).toBeTruthy();
    expect(r.querySelector(".ux-state-dot--done")).toBeNull();
  });

  it("(Mac walk 3) a List row's Status cell carries its rule in the tester's tree", () => {
    const card = shippable("c10", { reviewStatus: "conflict_blocked" });
    act(() => seedBoard([card]));
    act(() => useBoard.getState().setView(BOARD_WS, "list"));
    renderUi(<KanbanBoard workspaceId={BOARD_WS} />, { fixtures: { card_review_tip: null } });
    const nodes = flatten(buildTree(document.body, { layout: false, terminals: { at: () => null }, maxNodes: 2000 }).nodes);
    const cell = nodes.find((n) => n.role === "cell" && n.name === "Ship stopped on a conflict");
    expect(cell?.states).toContain("rule=ship-conflict");
  });

  // UX P1 point 4 (P-B): a Builder waiting on the person goes to Needs you,
  // with rule 9's word, the same rule on the Board and the Inbox row.
  it("a Builder that stopped is in Needs you on the Board, 'Builder stopped', and the Inbox row carries its rule", async () => {
    const card = boardCard("c9", {
      title: "Card c9",
      notes: "Do it",
      columnId: "in_progress",
      lastRunStatus: "running",
      worktreePath: "/tmp/wt/c9",
      builder: { vendor: "claude", bypass: false, ptyId: "pty-9", sessionLost: false, startedAt: Date.now() - 10 * 60_000, snapshots: [] },
    } as Partial<KanbanCard>);
    act(() => seedBoard([card]));
    act(() =>
      useBuilder.setState({
        byCard: {
          c9: { workspaceId: BOARD_WS, ptyId: "pty-9", vendor: "claude", startedAt: Date.now() - 10 * 60_000, lastOutputAt: Date.now() - 30_000, promptBoxIdle: true, turnIdle: true, pending: [] } as never,
        },
      }),
    );
    // Working until the attention tick has seen it wait.
    const board = renderUi(<KanbanBoard workspaceId={BOARD_WS} />, { fixtures: { card_review_tip: null } });
    const column = (id: string) => document.querySelector(`[data-ply-board-card-id="${id}"]`)?.closest("[data-board-column]")?.getAttribute("data-board-column");
    expect(column("c9")).toBe("working");
    // The tick (App.tsx) feeds the same waitingSessions the Inbox counts.
    act(() => {
      const waiting = waitingSessions({
        tilesByWorkspace: {},
        builders: useBuilder.getState().byCard,
        cardTitle: () => card.title,
        card: (ws, id) => (ws === BOARD_WS && id === "c9" ? card : null),
        loaded: () => true,
        now: Date.now(),
      });
      useBuilderWaiting.getState().update(waiting, Date.now());
    });
    expect(column("c9")).toBe("needs-you");
    expect(boardWord("c9")).toEqual({ text: "Your turn · 10m", rule: "builder-waiting" });
    board.unmount();

    act(() =>
      useWorkspaces.setState({
        workspaces: [{ id: BOARD_WS, name: "Board", cwd: "/tmp/b", createdAt: 1, lastOpenedAt: 1, openFiles: [], activeFile: null }],
        activeId: BOARD_WS,
      }),
    );
    tauri().fixture("branch_cleanup_pending", []);
    renderUi(<InboxPanel />, { fixtures: { inbox_feed: feedOf([row(card, { id: "run:c9:r1", group: "running" })]) } });
    const needs = await screen.findByRole("group", { name: "Needs you" });
    expect(within(needs).getByText("Card c9")).toBeTruthy();
    // 1.173.0 (F1, BI-11): the Board card's headline and its one press.
    expect(within(needs).getByText("Your turn")).toBeTruthy();
    expect(within(needs).getByRole("button", { name: "Finish and check" })).toBeTruthy();
    expect(needs.querySelector('[data-ply-rule="builder-waiting"]')).toBeTruthy();
    // One ask, one row: Rust's Running row folds into the session's.
    expect(screen.queryByRole("group", { name: "Running" })).toBeNull();
    act(() => {
      useBuilderWaiting.setState({ byCard: {} });
      useBuilder.setState({ byCard: {} });
    });
  });

  // UX P-B Mac walk 1 and 2: one card, one row. The Challenger requested
  // changes and Claude ended a turn: one row, the card's ("Changes
  // requested"). Claude asks a question: one row, the session's, and the
  // card says "Asks you something" (rule 9 outranks the request).
  it("(Mac walk 1–2) a card at 'Reviewer requests changes' has one Inbox row, whether its Builder stopped or asks", async () => {
    const card = boardCard("c12", {
      title: "Card c12",
      notes: "Do it",
      columnId: "in_progress",
      lastRunStatus: "success",
      worktreePath: "/tmp/wt/c12",
      builder: {
        vendor: "claude",
        bypass: false,
        ptyId: "pty-12",
        sessionLost: false,
        startedAt: Date.now() - 10 * 60_000,
        snapshots: [{ n: 1, sha: "aaaaaaa1", at: Date.now() - 5 * 60_000 }],
        review: { snapshotN: 1, provider: "codex", degraded: false, status: "done", verdict: "changes_requested", at: Date.now() - 4 * 60_000 },
      },
    } as Partial<KanbanCard>);
    act(() => seedBoard([card]));
    act(() =>
      useWorkspaces.setState({
        workspaces: [{ id: BOARD_WS, name: "Board", cwd: "/tmp/b", createdAt: 1, lastOpenedAt: 1, openFiles: [], activeFile: null }],
        activeId: BOARD_WS,
      }),
    );
    const runtime = (questionInView: boolean) =>
      act(() =>
        useBuilder.setState({
          byCard: {
            c12: { workspaceId: BOARD_WS, ptyId: "pty-12", vendor: "claude", startedAt: Date.now() - 10 * 60_000, lastOutputAt: Date.now() - 30_000, promptBoxIdle: true, turnIdle: !questionInView, questionInView, pending: [] } as never,
          },
          sentAt: { c12: Date.now() - 60_000 },
        }),
      );
    const tick = () =>
      act(() => {
        const waiting = waitingSessions({
          tilesByWorkspace: {},
          builders: useBuilder.getState().byCard,
          cardTitle: () => card.title,
          card: (ws, id) => (ws === BOARD_WS && id === "c12" ? card : null),
          loaded: () => true,
          sentAt: useBuilder.getState().sentAt,
          now: Date.now(),
        });
        useBuilderWaiting.getState().update(waiting, Date.now());
      });
    tauri().fixture("branch_cleanup_pending", []);
    const changesRow = row(card, { id: "review:c12:r1", detail: "changes requested — needs you" });

    runtime(false);
    tick();
    const stopped = renderUi(<InboxPanel />, { fixtures: { inbox_feed: feedOf([changesRow]) } });
    let needs = await screen.findByRole("group", { name: "Needs you" });
    // 1.171.0 C1 (Challenger 5): the findings were not delivered into this
    // session and nothing went in since — the request's own row speaks.
    expect(within(needs).getByText("Reviewer requests changes")).toBeTruthy();
    expect(within(needs).queryByText("Your turn")).toBeNull();
    stopped.unmount();

    runtime(true);
    tick();
    renderUi(<InboxPanel />, { fixtures: { inbox_feed: feedOf([changesRow]) } });
    needs = await screen.findByRole("group", { name: "Needs you" });
    expect(within(needs).getByText("Asks you something")).toBeTruthy();
    expect(within(needs).queryByText("Reviewer requests changes")).toBeNull();
    expect(needs.querySelector('[data-ply-rule="builder-waiting"]')).toBeTruthy();
    act(() => {
      useBuilderWaiting.setState({ byCard: {} });
      useBuilder.setState({ byCard: {}, sentAt: {} });
    });
  });

  // UX P-B Mac walk 2: a card at Ready to ship whose Builder asks a
  // question. The first time the Inbox opened it read "The work is done ·
  // review it" with Review (rule=base) for seconds: its cards were
  // presented from the store the app's tick writes (behind, and held 3 s),
  // its session rows from the live session. Its first frame says the
  // question now, before any tick has seen it.
  it("(Mac walk 2) the Inbox's first frame says a ready card's question, before the tick has seen it", () => {
    const card = boardCard("c13", {
      title: "Card c13",
      notes: "Do it",
      columnId: "in_progress",
      lastRunStatus: "success",
      verifyStatus: "passed",
      verifyHistory: [{ status: "passed", steps: [] } as never],
      worktreePath: "/tmp/wt/c13",
      branchName: "atelier/card-c13",
      builder: {
        vendor: "claude",
        bypass: false,
        ptyId: "pty-13",
        sessionLost: false,
        startedAt: Date.now() - 60_000,
        snapshots: [{ n: 1, sha: "aaaaaaaa1", at: Date.now() - 30_000 }],
        review: { snapshotN: 1, provider: "codex", degraded: false, status: "done", verdict: "approve", at: Date.now() - 20_000 },
      },
    } as Partial<KanbanCard>);
    act(() => seedBoard([card]));
    act(() =>
      useWorkspaces.setState({
        workspaces: [{ id: BOARD_WS, name: "Board", cwd: "/tmp/b", createdAt: 1, lastOpenedAt: 1, openFiles: [], activeFile: null }],
        activeId: BOARD_WS,
      }),
    );
    // Claude's question picker is in view; its output was a moment ago.
    act(() =>
      useBuilder.setState({
        byCard: {
          c13: { workspaceId: BOARD_WS, ptyId: "pty-13", vendor: "claude", startedAt: Date.now() - 60_000, lastOutputAt: Date.now() - 1_000, promptBoxIdle: true, turnIdle: false, questionInView: true, pending: [] } as never,
        },
        sentAt: { c13: Date.now() - 50_000 },
        doneAt: { c13: Date.now() - 40_000 },
      }),
    );
    // No tick yet: the store does not list it.
    act(() => useBuilderWaiting.setState({ byCard: {} }));
    // Rust's row, as the feed already in the store has it.
    act(() => useInbox.setState({ feed: feedOf([row(card, {})]) }));
    tauri().fixture("branch_cleanup_pending", []);
    renderUi(<InboxPanel />, { fixtures: { inbox_feed: feedOf([row(card, {})]), card_review_tip: { branchTip: "aaaaaaaa1", commitsSinceReview: 0 } } });
    // The first frame, no await.
    const needs = screen.getByRole("group", { name: "Needs you" });
    expect(within(needs).getByText("Asks you something")).toBeTruthy();
    expect(within(needs).getByRole("button", { name: "Open the Builder" }).getAttribute("data-ply-rule")).toBe("builder-waiting");
    expect(within(needs).queryByText("The work is done · review it")).toBeNull();
    expect(within(needs).queryByRole("button", { name: "Review" })).toBeNull();
    expect(needs.querySelectorAll(".ux-row")).toHaveLength(1);
    act(() => useBuilder.setState({ byCard: {}, sentAt: {}, doneAt: {} }));
  });

  it("(Windows walk 1) a Ship the local branch refused is 'Ship didn't go through' on the Board, the List, the Inbox and Now, with its block in Now", async () => {
    const card = shippable("c11");
    act(() => seedBoard([card]));
    act(() =>
      useWorkspaces.setState({
        workspaces: [{ id: BOARD_WS, name: "Board", cwd: "/tmp/b", createdAt: 1, lastOpenedAt: 1, openFiles: [], activeFile: null }],
        activeId: BOARD_WS,
      }),
    );
    // The result the card page read; the page's own failed press is not set:
    // the refusal is GH #88's typed value, which only the error blocks keep.
    act(() =>
      useCardFacts.getState().setOutcome(card, {
        loading: false,
        filesChanged: 2,
        shipBusy: false,
        noRemote: false,
        reviewFreshness: "none",
      }),
    );
    const SKILL = ".claude/skills/walk-rule/SKILL.md";
    const refused: LocalBranchRefused = {
      operation: "land",
      localBranch: {
        branch: "staging",
        outcome: {
          kind: "untrackedDiffers",
          behind: 1,
          from: "759ae1a",
          to: "3ec1ef1",
          paths: [SKILL],
          items: [{ kind: "skill", name: "walk-rule", paths: [SKILL], directory: false }],
          output: `error: Untracked working tree file '${SKILL}' would be overwritten by merge.`,
          repeated: false,
        },
      },
    };
    const board = renderUi(<KanbanBoard workspaceId={BOARD_WS} />, { fixtures: { card_review_tip: null } });
    expect(boardWord("c11")).toEqual({ text: "Ready to ship", rule: "base" });
    // What the Ship press's catch does with it (OutcomeScreen, the Ship batch).
    act(() => {
      expect(observeShipAttempt(BOARD_WS, [card.id], "ship", { refused })).toBe(true);
    });
    expect(boardWord("c11")).toEqual({ text: "Ship didn't go through", rule: "ship-failed" });
    act(() => useBoard.getState().setView(BOARD_WS, "list"));
    const nodes = flatten(buildTree(document.body, { layout: false, terminals: { at: () => null }, maxNodes: 2000 }).nodes);
    expect(nodes.find((n) => n.role === "cell" && n.name === "Ship didn't go through")?.states).toContain("rule=ship-failed");
    board.unmount();

    tauri().fixture("branch_cleanup_pending", []);
    const inbox = renderUi(<InboxPanel />, { fixtures: { inbox_feed: feedOf([row(card, {})]) } });
    const needs = await screen.findByRole("group", { name: "Needs you" });
    expect(within(needs).getByText("Ship didn't go through")).toBeTruthy();
    expect(within(needs).getByRole("button", { name: "Try again" }).getAttribute("data-ply-rule")).toBe("ship-failed");
    expect(within(needs).queryByRole("button", { name: "Ship it" })).toBeNull();
    inbox.unmount();

    useUi.setState({ selectedCardId: { [BOARD_WS]: card.id }, centerMode: { [BOARD_WS]: "board" } });
    const page = renderUi(<CardDetailPanel workspaceId={BOARD_WS} />, {
      fixtures: { ...PAGE_FIXTURES, kanban_load: () => [card] },
    });
    page.tauri.allowUnhandled();
    // The Shipping section is closed; Now draws the refusal and its two ways out.
    expect(document.querySelector('[data-ply-card-section="ship"]')?.getAttribute("aria-hidden")).toBe("true");
    // (Under the Now callout, where a failed press's block is drawn; the
    // closed Shipping section's own copy is hidden and inert.)
    const outsideShipping = (el: Element) => el.closest('[data-ply-card-section="ship"]') === null;
    expect(screen.getAllByText("Ship stopped: local staging can't be updated.").filter(outsideShipping)).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Publish your version" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Move the local copy to Trash" })).toBeTruthy();

    // The way cleared (a Sync or the Trash took the condition down): every
    // surface says Ready to ship again, and Now draws no block.
    act(() => useErrorBlocks.getState().setLocalBranch(BOARD_WS, null));
    expect(screen.queryAllByText("Ship stopped: local staging can't be updated.")).toHaveLength(0);
    page.unmount();
    renderUi(<KanbanBoard workspaceId={BOARD_WS} />, { fixtures: { card_review_tip: null } });
    act(() => useBoard.getState().setView(BOARD_WS, "board"));
    expect(boardWord("c11")).toEqual({ text: "Ready to ship", rule: "base" });
  });

  it("(Windows walk 2) a Retry ship refused at the merge on a card stopped on a conflict is 'Ship didn't go through' everywhere, the conflict not beside it", async () => {
    const card = shippable("c12", { reviewStatus: "conflict_blocked" });
    act(() => seedBoard([card]));
    act(() =>
      useWorkspaces.setState({
        workspaces: [{ id: BOARD_WS, name: "Board", cwd: "/tmp/b", createdAt: 1, lastOpenedAt: 1, openFiles: [], activeFile: null }],
        activeId: BOARD_WS,
      }),
    );
    const SKILL = ".claude/skills/walk-rule/SKILL.md";
    const refused: LocalBranchRefused = {
      operation: "land",
      atMerge: true,
      localBranch: {
        branch: "trunk",
        outcome: {
          kind: "untrackedDiffers",
          behind: 0,
          from: "759ae1a",
          to: "3ec1ef1",
          paths: [SKILL],
          items: [{ kind: "skill", name: "walk-rule", paths: [SKILL], directory: false }],
          output: `error: The following untracked working tree files would be overwritten by merge:\n\t${SKILL}`,
          repeated: false,
        },
      },
    };
    const board = renderUi(<KanbanBoard workspaceId={BOARD_WS} />, { fixtures: { card_review_tip: null } });
    expect(boardWord("c12")).toEqual({ text: "Ship stopped on a conflict", rule: "ship-conflict" });
    act(() => {
      expect(observeShipAttempt(BOARD_WS, [card.id], "ship", { refused })).toBe(true);
    });
    expect(boardWord("c12")).toEqual({ text: "Ship didn't go through", rule: "ship-failed" });
    act(() => useBoard.getState().setView(BOARD_WS, "list"));
    const nodes = flatten(buildTree(document.body, { layout: false, terminals: { at: () => null }, maxNodes: 2000 }).nodes);
    expect(nodes.find((n) => n.role === "cell" && n.name === "Ship didn't go through")?.states).toContain("rule=ship-failed");
    board.unmount();

    tauri().fixture("branch_cleanup_pending", []);
    // Rust's row is still the conflict's: the card's words win.
    const inbox = renderUi(<InboxPanel />, {
      fixtures: { inbox_feed: feedOf([row(card, { id: "conflict:c12:manual", detail: "ship stopped on a conflict" })]) },
    });
    const needs = await screen.findByRole("group", { name: "Needs you" });
    expect(within(needs).getByText("Ship didn't go through")).toBeTruthy();
    expect(within(needs).queryByText("Ship stopped on a conflict")).toBeNull();
    expect(within(needs).getByRole("button", { name: "Try again" }).getAttribute("data-ply-rule")).toBe("ship-failed");
    inbox.unmount();

    useUi.setState({ selectedCardId: { [BOARD_WS]: card.id }, centerMode: { [BOARD_WS]: "board" } });
    const page = renderUi(<CardDetailPanel workspaceId={BOARD_WS} />, {
      fixtures: { ...PAGE_FIXTURES, kanban_load: () => [card] },
    });
    page.tauri.allowUnhandled();
    const now = screen.getByRole("region", { name: "Now" });
    expect(now.getAttribute("data-ply-rule")).toBe("ship-failed");
    expect(within(now).getByText("Ship didn't go through")).toBeTruthy();
    expect(within(now).queryByText("Ship stopped on a conflict")).toBeNull();
    expect(within(now).queryByText("The last ship stopped on a conflict.")).toBeNull();
    // Its block under Now, in the merge's words, with both ways out — not a
    // generic "couldn't finish".
    const outsideShipping = (el: Element) => el.closest('[data-ply-card-section="ship"]') === null;
    expect(screen.getAllByText("Ship stopped: local trunk can't be updated.").filter(outsideShipping)).toHaveLength(1);
    expect(screen.getAllByText(/would be overwritten by the card's copy/).filter(outsideShipping)).toHaveLength(1);
    expect(screen.queryByText(/couldn't finish/)).toBeNull();
    expect(screen.getByRole("button", { name: "Publish your version" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Move the local copy to Trash" })).toBeTruthy();
    // The way cleared: the recorded conflict is said again.
    act(() => useErrorBlocks.getState().setLocalBranch(BOARD_WS, null));
    expect(within(screen.getByRole("region", { name: "Now" })).getByText("Ship stopped on a conflict")).toBeTruthy();
    page.unmount();
  });

  it("the tester's tree names a Details disclosure 'Details'", () => {
    document.body.innerHTML =
      '<details class="ux-details" open><summary class="ux-details-summary">Technical details</summary><div>worktree /tmp/x</div></details>';
    const nodes = flatten(buildTree(document.body, { layout: false, terminals: { at: () => null }, maxNodes: 100 }).nodes);
    expect(nodes.find((n) => n.role === "group")?.name).toBe("Details");
  });
});
