// SP-1 phase 2: the result and its diff on the real card page with the real
// OutcomeScreen — the pair stays open, and the diff panel the same element,
// while the result is refetched (after a build, a review).
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import { CardDetailPanel } from "../components/CardDetailPanel";
import type { CardOutcome, KanbanCard } from "../ipc";
import { useKanban } from "../store/kanbanStore";
import { useUi } from "../store/uiStore";
import { BOARD_WS, boardCard, seedBoard } from "./boardFixtures";
import { act, renderUi, screen, waitFor, within } from "./render";

const mounts = vi.hoisted(() => ({ diff: 0 }));
vi.mock("../components/CardReviewPanel", () => ({
  CardReviewPanel: ({ card, openPrNumber }: { card: KanbanCard; openPrNumber?: number | null }) => {
    useEffect(() => {
      mounts.diff += 1;
    }, []);
    return <div data-testid="review-diff" data-card={card.id} data-pr={String(openPrNumber ?? "")} />;
  },
}));
vi.mock("../components/BuilderSession", () => ({ BuilderSession: () => <div data-testid="builder-terminal" /> }));

const result: CardOutcome = { filesChanged: 2, verifyConfigured: false, isRecon: false, reconVerdictNegative: false };

describe("the pair across a refetch of the result (SP-1 phase 2)", () => {
  it("stays open while the result reloads, the diff panel the same element", async () => {
    mounts.diff = 0;
    const card = boardCard("c1", {
      notes: "x",
      columnId: "complete",
      lastRunStatus: "success",
      verifyStatus: "passed",
      worktreePath: "/tmp/ply-test/c1",
      branchName: "card/c1",
    });
    seedBoard([card]);
    useUi.setState({ selectedCardId: { [BOARD_WS]: card.id }, centerMode: { [BOARD_WS]: "board" }, cardStep: {}, cardDiffOpen: {} });
    // The second fetch waits until the test lets it answer.
    let answer: ((o: CardOutcome) => void) | null = null;
    let fetches = 0;
    const view = renderUi(<CardDetailPanel workspaceId={BOARD_WS} />, {
      fixtures: {
        card_outcome: () => {
          fetches += 1;
          return fetches === 1 ? result : new Promise<CardOutcome>((r) => (answer = r));
        },
        card_overlap_check: [],
        reviewer_list: [],
        verify_status: null,
        improvement_proposal_state: null,
        improvement_proposal_trust_stopped: null,
        ship_pending_release: { release: null, unreadable: null },
        card_review_tip: null,
      },
    });
    view.tauri.allowUnhandled();
    const panel = await screen.findByTestId("review-diff");
    act(() => useUi.getState().openCardDiff("c1"));
    const section = (name: string) => document.querySelector<HTMLElement>(`[data-ply-card-section="${name}"]`)!;
    const body = () => document.querySelector(".ux-card-body")!;
    expect(section("diff").getAttribute("aria-hidden")).toBeNull();
    expect(body().hasAttribute("data-ply-card-pair")).toBe(true);

    // A review settles: the result is fetched again.
    act(() => {
      useKanban.setState({
        byWorkspace: { [BOARD_WS]: { cards: [{ ...card, reviewStatus: "changes_requested" } as KanbanCard], loaded: true } },
      });
    });
    await waitFor(() => expect(fetches).toBe(2));
    // Loading: the pair holds, nothing reflowed or remounted.
    expect(section("diff").getAttribute("aria-hidden")).toBeNull();
    expect(body().hasAttribute("data-ply-card-pair")).toBe(true);
    expect(screen.getByTestId("review-diff")).toBe(panel);

    await act(async () => answer!(result));
    expect(section("diff").getAttribute("aria-hidden")).toBeNull();
    expect(screen.getByTestId("review-diff")).toBe(panel);
    expect(mounts.diff).toBe(1);
  });

  it("never carries the last card's diff (or its pull request) into the next card (review 2)", async () => {
    const a = boardCard("a", {
      notes: "x",
      columnId: "in_progress",
      lastRunStatus: "success",
      reviewStatus: "merged",
      prUrl: "https://github.com/o/r/pull/9",
      pr: {
        number: 9,
        state: "open",
        checks: "passing",
        checksTotal: 1,
        checksPassed: 1,
        checksPending: 0,
        failingChecks: [],
        mergeable: "mergeable",
        reviewDecision: "none",
        openedAt: 1,
        checkedAt: 2,
      },
      worktreePath: "/tmp/ply-test/a",
      branchName: "card/a",
    });
    const b = boardCard("b", {
      notes: "y",
      columnId: "complete",
      lastRunStatus: "success",
      verifyStatus: "passed",
      worktreePath: "/tmp/ply-test/b",
      branchName: "card/b",
    });
    seedBoard([a, b]);
    useUi.setState({ selectedCardId: { [BOARD_WS]: "a" }, centerMode: { [BOARD_WS]: "board" }, cardStep: {}, cardDiffOpen: {} });
    let answerB: ((o: CardOutcome) => void) | null = null;
    const view = renderUi(<CardDetailPanel workspaceId={BOARD_WS} />, {
      fixtures: {
        card_outcome: (args: Record<string, unknown>) =>
          args.cardId === "b" ? new Promise<CardOutcome>((r) => (answerB = r)) : result,
        card_overlap_check: [],
        reviewer_list: [],
        verify_status: null,
        improvement_proposal_state: null,
        improvement_proposal_trust_stopped: null,
        ship_pending_release: { release: null, unreadable: null },
        card_review_tip: null,
      },
    });
    view.tauri.allowUnhandled();
    // Card A: its open pull request's diff.
    await waitFor(() => expect(screen.getByTestId("review-diff").getAttribute("data-pr")).toBe("9"));

    // Card B, its result still loading, its pair asked for.
    act(() => useUi.getState().selectCard(BOARD_WS, "b", true));
    act(() => useUi.getState().openCardDiff("b"));
    await waitFor(() => expect(document.querySelector('[data-ply-card-host][data-ply-card-id="b"]')).toBeTruthy());
    expect(screen.queryByTestId("review-diff")).toBeNull();
    expect(document.querySelector('[data-pr="9"]')).toBeNull();
    expect(document.querySelector(".ux-card-body")!.hasAttribute("data-ply-card-pair")).toBe(false);

    // B's own result says it has a diff: B's, with no pull request.
    await waitFor(() => expect(answerB).not.toBeNull());
    await act(async () => answerB!(result));
    const panel = await screen.findByTestId("review-diff");
    expect(panel.getAttribute("data-card")).toBe("b");
    expect(panel.getAttribute("data-pr")).toBe("");
    expect(document.querySelector(".ux-card-body")!.hasAttribute("data-ply-card-pair")).toBe(true);
  });
});

describe("a press that fails after the page moved on (SP-1 review 4)", () => {
  it("is not drawn on the card now shown; a toast names the card it was for, with Show", async () => {
    const ready = (id: string, title: string) =>
      boardCard(id, {
        title,
        notes: "x",
        columnId: "complete",
        lastRunStatus: "success",
        verifyStatus: "passed",
        worktreePath: `/tmp/ply-test/${id}`,
        branchName: `card/${id}`,
      });
    const a = ready("a", "Card A");
    const b = ready("b", "Card B");
    seedBoard([a, b]);
    useUi.setState({ selectedCardId: { [BOARD_WS]: "a" }, centerMode: { [BOARD_WS]: "board" }, cardStep: {}, cardDiffOpen: {} });
    let refuse: ((e: unknown) => void) | null = null;
    const view = renderUi(<CardDetailPanel workspaceId={BOARD_WS} />, {
      withToasts: true,
      fixtures: {
        card_outcome: result,
        card_ship: () => new Promise((_, reject) => (refuse = reject)),
        card_overlap_check: [],
        reviewer_list: [],
        verify_status: null,
        improvement_proposal_state: null,
        improvement_proposal_trust_stopped: null,
        ship_pending_release: { release: null, unreadable: null },
        card_review_tip: null,
      },
    });
    view.tauri.allowUnhandled();
    const now = () => within(screen.getByRole("region", { name: "Now" }));
    await waitFor(() => expect(now().getByText("Ready to ship")).toBeTruthy());
    await view.user.click(now().getByRole("button", { name: "Ship it" }));
    await waitFor(() => expect(refuse).not.toBeNull());

    act(() => useUi.getState().selectCard(BOARD_WS, "b", true));
    await waitFor(() => expect(document.querySelector('[data-ply-card-host][data-ply-card-id="b"]')).toBeTruthy());
    await act(async () => refuse!("the remote moved"));

    // The toast says it, for card A, with Show — and once it has, card B
    // shows no error of A's (checked after the failure was handled).
    const toast = await screen.findByText("Ship it didn't go through for “Card A”.");
    expect(toast).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show" })).toBeTruthy();
    expect(document.querySelector(".ux-card-body .ux-error")).toBeNull();
    expect(screen.queryByText(/didn't go through/, { selector: ".ux-card-body *" })).toBeNull();
  });
});
