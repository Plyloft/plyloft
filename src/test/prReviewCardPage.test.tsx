// Challenger on a pull request: the whole card page of a card that reviews
// someone else's pull request — the review's Now, no Start build, no Ship,
// no result or diff section opening by itself after a verdict, and the
// Board's ⋯ items a pull request review has no use for left out.
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import { CardDetailPanel } from "../components/CardDetailPanel";
import type { KanbanCard } from "../ipc";
import { useUi } from "../store/uiStore";
import { BOARD_WS, boardCard, seedBoard } from "./boardFixtures";
import { act, renderUi, screen } from "./render";

vi.mock("../components/BuilderSession", () => ({
  BuilderSession: () => {
    useEffect(() => {}, []);
    return <div data-testid="builder-terminal" />;
  },
}));

const HEAD = "1111111111111111111111111111111111111111";

function prCard(over: Partial<KanbanCard> = {}): KanbanCard {
  return boardCard("card-x-pr12", {
    title: "Review: Add the retry",
    notes: "Pull request #12 by @octo: Add the retry",
    columnId: "in_progress",
    worktreePath: "/tmp/ply-test/card-x-pr12",
    branchName: "plyloft/card-xpr12-review-add-the-retry",
    reviewStatus: "changes_requested",
    builder: {
      vendor: "claude",
      bypass: false,
      startedAt: 0,
      snapshots: [{ n: 1, sha: HEAD, at: 1 }],
      review: {
        snapshotN: 1,
        provider: "codex",
        degraded: false,
        status: "done",
        verdict: "changes_requested",
        at: 2,
        reviewId: "r1",
      },
    } as KanbanCard["builder"],
    prReview: {
      url: "https://github.com/o/r/pull/12",
      number: 12,
      repo: "o/r",
      title: "Add the retry",
      author: "octo",
      baseRef: "main",
      headRef: "retry-upload",
      headSha: HEAD,
      branchHead: HEAD,
      crossRepository: false,
      pushable: false,
      fixNote: "This is octo's pull request: the Reviewer only reviews it, and the Builder doesn't change it.",
      state: "open",
      checkedAt: 1,
      heads: [1],
    },
    ...over,
  });
}

function open(card: KanbanCard) {
  seedBoard([card]);
  useUi.setState({ selectedCardId: { [BOARD_WS]: card.id }, centerMode: { [BOARD_WS]: "board" } });
  const view = renderUi(<CardDetailPanel workspaceId={BOARD_WS} />, {
    fixtures: {
      pr_review_refresh: () => card,
      kanban_load: () => [card],
      reviewer_list: [],
      verify_status: null,
      improvement_proposal_state: null,
      improvement_proposal_trust_stopped: null,
      card_review_tip: null,
      card_overlap_check: [],
      ship_pending_release: { release: null, unreadable: null },
    },
  });
  view.tauri.allowUnhandled();
  return view;
}

describe("the card page of a pull request review", () => {
  it("is the review's: no Start build, no Ship, the result stays closed", async () => {
    const { user } = open(prCard());
    expect(document.querySelector("[data-ply-pr-review]")?.getAttribute("data-ply-pr-review")).toBe("current");
    expect(screen.getAllByText("Changes requested").length).toBeGreaterThan(0);
    expect(screen.getByText(/asked for changes. Its findings stay here in Plyloft/)).toBeTruthy();
    for (const name of [/^Start build/, /^Ship/, "Fix with the Builder", /^Resume/, /^Start fresh/]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    // A verdict opens "The result" on other cards; here it stays shut.
    for (const name of ["outcome", "ship"]) {
      expect(document.querySelector(`[data-ply-card-section="${name}"]`)?.getAttribute("aria-hidden")).toBe("true");
    }
    expect(screen.queryByTestId("builder-terminal")).toBeNull();
    // The ⋯: archive and delete, never a release, a second build or a plan.
    await user.click(screen.getByRole("button", { name: "More for this card" }));
    expect(screen.getByRole("menuitem", { name: "Archive" })).toBeTruthy();
    for (const name of ["Release…", "Build with both", "Challenge the plan…", "Move back to Ready to start…", "Plan with two AIs…"]) {
      expect(screen.queryByRole("menuitem", { name })).toBeNull();
    }
  });

  // Walk of #386 (step 4): someone else's pull request has no Builder —
  // no Builder property, no notes for one, no hand-off words in Status, and
  // the Chat and the diff say what the card is.
  it("someone else's: a review-only Status, no Builder, the Chat's and the diff's words fit", async () => {
    const card = prCard({
      builder: { ...prCard().builder!, undeliveredVerdict: { snapshotN: 1, at: 2 } },
    });
    open(card);
    const status = screen.getByText("Status").closest(".ux-prop, li, div")!.parentElement!;
    expect(status.textContent).toContain("Changes requested · review only");
    expect(screen.queryByText(/have not reached the Builder/)).toBeNull();
    expect(screen.queryByText("Builder")).toBeNull();
    expect(screen.queryByText("Notes for the Builder")).toBeNull();
    // 1.172.0 (C1): its new place, the Brief's More detail, isn't there either.
    expect(screen.queryByText("More detail (optional)")).toBeNull();
    act(() => useUi.getState().setCardStep(card.id, "chat"));
    expect(await screen.findByText(/someone else's pull request: Plyloft only reviews it/)).toBeTruthy();
    expect(screen.queryByText(/Code changes stay with the card's Builder/)).toBeNull();
  });

  // Walk of #386 (step 7): the member's own pull request before its first
  // Builder: no closed session to resume, no owed verdict — the way on is
  // Fix with the Builder.
  it("the member's own, Builder never started: no Session closed, no Resume", () => {
    const card = prCard({
      prReview: { ...prCard().prReview!, pushable: true, fixNote: null, author: "me" },
      builder: { ...prCard().builder!, undeliveredVerdict: { snapshotN: 1, at: 2 } },
    });
    open(card);
    act(() => useUi.getState().setCardStep(card.id, "run"));
    expect(document.querySelector("[data-ply-builder-not-started]")?.textContent).toMatch(/hasn't started on this card/);
    expect(screen.queryByText("Session closed")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Resume/ })).toBeNull();
    expect(screen.queryByText(/have not reached the Builder/)).toBeNull();
    expect(screen.getByRole("button", { name: "Fix with the Builder" })).toBeTruthy();
    expect(screen.getAllByText("Changes requested").length).toBeGreaterThan(0);
    expect(screen.getByText("Builder")).toBeTruthy();
  });

  // 1.175.0 G7 (proof P3): the copy of somebody else's pull request sits
  // under a folder Claude already trusts, so a session there runs that
  // copy's own settings without asking. The card offers no terminal in it,
  // in Technical details or in ⋯; the row's other two buttons stay. The
  // member's own pull request and an ordinary card keep both.
  it.each([
    ["somebody else's pull request", prCard(), false],
    ["the member's own pull request", prCard({ prReview: { ...prCard().prReview!, pushable: true, fixNote: null, author: "me" } }), true],
    ["an ordinary card", prCard({ prReview: undefined, title: "A card", notes: "x" }), true],
  ])("a terminal in the card's copy, on %s", async (_label, card, offered) => {
    const { user } = open(card);
    const NAME = "Open a terminal in the card's copy";
    expect(screen.queryAllByRole("button", { name: NAME, hidden: true }).length > 0).toBe(offered);
    expect(screen.getByRole("button", { name: "Copy the path of the card's copy", hidden: true })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Show the card's copy in /, hidden: true })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "More for this card" }));
    expect(screen.queryAllByRole("menuitem", { name: NAME }).length > 0).toBe(offered);
  });

  // Plan with two AIs is for a card not built yet; a pull request's card
  // reviews (or fixes) code that exists: never offered, wherever it sits,
  // neither in the ⋯ nor in the Chat tab's Plan switch. The same card
  // without its pull request is offered it (the control).
  it.each([
    ["a pull request's card", true],
    ["the same card without its pull request", false],
  ])("Plan with two AIs in To do, with no Builder record: %s", async (_label, isPr) => {
    const card = prCard({ columnId: "todo", builder: undefined, reviewStatus: undefined, ...(isPr ? {} : { prReview: undefined }) });
    const { user } = open(card);
    act(() => useUi.getState().setCardStep(card.id, "chat"));
    const chat = await screen.findAllByRole("button", { name: "Ask about this card" });
    expect(chat).toBeTruthy();
    expect(screen.queryAllByRole("button", { name: "Plan with two AIs" }).length > 0).toBe(!isPr);
    // 1.172.0 (C1): on the card without a pull request it is Now's Plan it
    // first ▾; the ⋯ never has it.
    await user.click(screen.getByRole("button", { name: "More for this card" }));
    expect(screen.queryAllByRole("menuitem", { name: "Plan with two AIs…" })).toHaveLength(0);
    await user.keyboard("{Escape}");
    const planFirst = screen.queryByRole("button", { name: "Plan it first" });
    expect(planFirst != null).toBe(!isPr);
    if (planFirst) {
      await user.click(planFirst);
      expect(screen.getByRole("menuitem", { name: "Plan with two AIs" })).toBeTruthy();
    }
  });
});
