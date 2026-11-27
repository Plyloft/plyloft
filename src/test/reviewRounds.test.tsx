// CL-5: a review round's "See its findings" narrows the card's findings to
// the ids the round stored — raised, closed or still open in it — until
// "Show all findings", and never narrows a newer review.
import { beforeEach, describe, expect, it } from "vitest";
import { tauri } from "./tauri";
import { ChallengerFindings } from "../components/ChallengerFindings";
import { CardReviewPanel } from "../components/CardReviewPanel";
import type { BuilderReview, FindingAnchor, KanbanCard, LedgerFinding, ReviewDiff, ReviewRound } from "../ipc";
import { useKanban } from "../store/kanbanStore";
import { useUi } from "../store/uiStore";
import { act, renderUi, screen, waitFor, within } from "./render";

const card: KanbanCard = {
  id: "card-1",
  workspaceId: "ws-1",
  title: "Rounds",
  columnId: "complete",
  createdAt: 1,
  updatedAt: 1,
};

const finding = (id: string, round: number, updatedRound: number, state: LedgerFinding["state"]): LedgerFinding => ({
  id,
  severity: "P2",
  preExisting: false,
  location: null,
  reason: null,
  title: `Finding ${id}`,
  body: "Body.",
  reviewId: "rev-1",
  round,
  state,
  updatedRound,
});

const review: BuilderReview = {
  snapshotN: 3,
  provider: "codex",
  degraded: false,
  status: "done",
  verdict: "changes_requested",
  reviewId: "rev-3",
  at: 1,
  ledger: [
    finding("F1", 1, 2, "closed"),
    finding("F2", 1, 1, "open"),
    finding("F3", 2, 3, "still-open"),
    finding("F4", 3, 3, "open"),
  ],
};

const ids = (container: HTMLElement) =>
  [...container.querySelectorAll("[data-ply-finding-id]")].map((e) => e.getAttribute("data-ply-finding-id"));

// PR #375: the panel reads a Builder card's branch tip (none here).
beforeEach(() => tauri().fixture("card_review_tip", null));

describe("review rounds (CL-5)", () => {
  beforeEach(() => useUi.setState({ reviewRoundFilter: {} }));

  it("shows every finding when no round is chosen", () => {
    const { container } = renderUi(<ChallengerFindings card={card} review={review} />);
    expect(ids(container).sort()).toEqual(["F1", "F2", "F3", "F4"]);
    expect(container.querySelector("[data-ply-ledger-round]")).toBeNull();
  });

  it("narrows to the chosen round, then shows all again", async () => {
    useUi.getState().setReviewRoundFilter(card.id, { round: 2, ids: ["F1", "F3"], reviewId: "rev-3" });
    const { container, user } = renderUi(<ChallengerFindings card={card} review={review} />);
    expect(ids(container).sort()).toEqual(["F1", "F3"]);
    expect(container.querySelector("[data-ply-ledger-round]")!.textContent).toContain(
      "Findings of round 2: raised, closed or still open in it.",
    );
    await user.click(screen.getByRole("button", { name: "Show all findings" }));
    expect(ids(container).sort()).toEqual(["F1", "F2", "F3", "F4"]);
    expect(useUi.getState().reviewRoundFilter[card.id]).toBeUndefined();
  });

  // Round 2 review (F1): a finding a round left unanswered is still open in
  // it, though its own updatedRound is an earlier round — shown by its id.
  it("a round's still open finding is shown although a later round never touched it", () => {
    useUi.getState().setReviewRoundFilter(card.id, { round: 3, ids: ["F2"], reviewId: "rev-3" });
    const { container } = renderUi(<ChallengerFindings card={card} review={review} />);
    expect(ids(container)).toEqual(["F2"]);
    expect(container.querySelector("[data-ply-finding-id='F2']")!.getAttribute("data-ply-finding-state")).toBe("open");
  });

  it("never narrows a newer review than the one it was chosen on", () => {
    useUi.getState().setReviewRoundFilter(card.id, { round: 2, ids: ["F1"], reviewId: "rev-2" });
    const { container } = renderUi(<ChallengerFindings card={card} review={review} />);
    expect(ids(container)).toHaveLength(4);
  });

  it("says so when the ledger no longer keeps a round's findings", () => {
    useUi.getState().setReviewRoundFilter(card.id, { round: 9, ids: ["F40"], reviewId: "rev-3" });
    const { container } = renderUi(<ChallengerFindings card={card} review={review} />);
    expect(container.querySelector("[data-ply-ledger-round]")!.textContent).toContain(
      "No finding of round 9 is kept any more.",
    );
  });
});

// SP-6: rounds only in Activity — the diff now has its own switch, "All ·
// Round 1 · Round 2 …", writing the same filter the list reads.
describe("the round switch above the diff (SP-6)", () => {
  const anchor = (id: string, line: number): FindingAnchor => ({
    id,
    severity: "P2",
    state: "open",
    nonBlocking: false,
    title: `Finding ${id}`,
    body: "Body.",
    reason: null,
    round: 1,
    updatedRound: 1,
    path: "src/a.ts",
    reviewedLine: line,
    line,
    fate: "same",
  });
  const diff: ReviewDiff = {
    cardId: "card-1",
    baseBranch: "main",
    cardBranch: "card/card-1",
    generatedAt: 1,
    files: [
      {
        path: "src/a.ts",
        kind: "modified",
        hunks: [{ header: "@@ -10,2 +10,3 @@", oldStart: 10, oldLines: 2, newStart: 10, newLines: 3, body: " keep\n+new a\n+new b\n" }],
      },
    ],
    anchors: [anchor("F1", 11), anchor("F2", 12), anchor("F3", 10)],
  };
  const round = (n: number, over: Partial<ReviewRound>): ReviewRound => ({
    round: n,
    new: 0,
    closed: 0,
    stillOpen: 0,
    verdict: "changes_requested",
    at: n,
    provider: "codex",
    reviewId: `rev-${n}`,
    snapshotN: n,
    ...over,
  });
  const built = {
    ...card,
    worktreePath: "/tmp/ply-test/card-1",
    branchName: "card/card-1",
    builder: {
      vendor: "claude",
      bypass: false,
      ptyId: null,
      sessionLost: false,
      startedAt: 1,
      snapshots: [],
      review: { ...review, reviewId: "rev-2" },
      reviewRounds: [round(1, { newIds: ["F1", "F2"] }), round(2, { newIds: ["F3"], closedIds: ["F1"] })],
    },
  } as KanbanCard;
  const shown = () => [...document.querySelectorAll("[data-ply-diff-anchor]")].map((e) => e.getAttribute("data-ply-diff-anchor")).sort();

  beforeEach(() => {
    useUi.setState({ reviewRoundFilter: {}, findingFocus: null, diffAnchorIds: {}, findingLists: {} });
    useKanban.setState({ byWorkspace: { "ws-1": { cards: [built], loaded: true } } } as never);
  });

  it("narrows the diff's findings to a round, writing the filter the list reads, and back to All", async () => {
    const { user } = renderUi(<CardReviewPanel workspaceId="ws-1" card={built} />, { fixtures: { card_review_diff: diff } });
    await waitFor(() => expect(shown()).toEqual(["F1", "F2", "F3"]));
    const sw = screen.getByRole("group", { name: "Findings of review round" });
    expect(within(sw).getAllByRole("button").map((b) => b.textContent)).toEqual(["All", "Round 1", "Round 2"]);
    expect(within(sw).getByRole("button", { name: "All" }).getAttribute("aria-pressed")).toBe("true");
    await user.click(within(sw).getByRole("button", { name: "Round 2" }));
    expect(shown()).toEqual(["F1", "F3"]);
    expect(useUi.getState().reviewRoundFilter[card.id]).toEqual({ round: 2, ids: ["F3", "F1"], reviewId: "rev-2" });
    expect(document.querySelector("[data-ply-anchor-intro]")!.textContent).toContain(
      "Findings raised or closed in round 2: 2 are under the lines they name.",
    );
    await user.click(within(sw).getByRole("button", { name: "All" }));
    expect(shown()).toEqual(["F1", "F2", "F3"]);
    expect(useUi.getState().reviewRoundFilter[card.id]).toBeUndefined();
  });

  it("follows a round chosen in Activity, and never narrows a newer review", async () => {
    useUi.getState().setReviewRoundFilter(card.id, { round: 1, ids: ["F1", "F2"], reviewId: "rev-2" });
    renderUi(<CardReviewPanel workspaceId="ws-1" card={built} />, { fixtures: { card_review_diff: diff } });
    await waitFor(() => expect(shown()).toEqual(["F1", "F2"]));
    const sw = screen.getByRole("group", { name: "Findings of review round" });
    expect(within(sw).getByRole("button", { name: "Round 1" }).getAttribute("aria-pressed")).toBe("true");
    act(() => useUi.getState().setReviewRoundFilter(card.id, { round: 1, ids: ["F1"], reviewId: "rev-1" }));
    await waitFor(() => expect(shown()).toEqual(["F1", "F2", "F3"]));
  });
});
