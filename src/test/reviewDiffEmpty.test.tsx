// Team walk 2026-10-02 (C4): the review's diff said "This swarm changed
// nothing." while it was still loading, and on cards with no swarm. It says
// it is loading until this card's own read lands — never the previous card's
// answer — and an empty diff speaks in the card's terms.
import { beforeEach, describe, expect, it } from "vitest";
import { tauri } from "./tauri";
import { CardReviewPanel, emptyDiffLine, NO_WORKTREE_DIFF } from "../components/CardReviewPanel";
import type { KanbanCard, ReviewDiff } from "../ipc";
import { renderUi, screen } from "./render";
import { setPlatformForTests } from "../lib/platform";

const WS = "ws-1";
const card = (id: string, over: Partial<KanbanCard> = {}): KanbanCard =>
  ({
    id,
    workspaceId: WS,
    title: id,
    columnId: "in_progress",
    worktreePath: `/tmp/ply-test/${id}`,
    branchName: `card/${id}`,
    builder: { vendor: "claude", bypass: false, ptyId: "p", sessionLost: false, startedAt: 1, snapshots: [] },
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }) as KanbanCard;

const empty = (cardId: string): ReviewDiff => ({
  cardId,
  baseBranch: "main",
  cardBranch: `card/${cardId}`,
  files: [],
  generatedAt: 1,
});

// PR #375: the panel reads a Builder card's branch tip (none here).
beforeEach(() => tauri().fixture("card_review_tip", null));

describe("the review's empty diff (C4)", () => {
  it("names a build, a swarm or the branch", () => {
    expect(emptyDiffLine(card("a"))).toBe("This build changed nothing.");
    expect(emptyDiffLine(card("a", { linkedSwarmId: "s1" }))).toBe("This multi-AI run changed nothing.");
    expect(emptyDiffLine(card("a", { builder: null }))).toBe("Nothing has changed on this card's branch.");
  });

  it("loads before it says anything, and never shows another card's answer", async () => {
    let answer: (d: ReviewDiff) => void = () => {};
    const { rerender } = renderUi(<CardReviewPanel workspaceId={WS} card={card("one")} />, {
      fixtures: {
        card_review_diff: ({ cardId }: Record<string, unknown>) =>
          cardId === "one" ? empty("one") : new Promise<ReviewDiff>((resolve) => (answer = resolve)),
      },
    });
    expect(await screen.findByText("This build changed nothing.")).toBeTruthy();
    // Another card: its own read has not landed, so it is loading.
    rerender(<CardReviewPanel workspaceId={WS} card={card("two")} />);
    expect(screen.queryByText("This build changed nothing.")).toBeNull();
    expect(screen.getByText("Loading the changes…")).toBeTruthy();
    answer({
      ...empty("two"),
      files: [{ path: "sum.js", kind: "modified", hunks: [] } as never],
    });
    await screen.findByText(/sum\.js/);
    expect(screen.queryByText(/changed nothing/)).toBeNull();
  });

  it("says there is no diff yet for a card with no worktree, and never loads", async () => {
    const { tauri } = renderUi(
      <CardReviewPanel workspaceId={WS} card={card("bare", { worktreePath: null })} />,
    );
    expect(screen.getByText(NO_WORKTREE_DIFF)).toBeTruthy();
    expect(NO_WORKTREE_DIFF).toBe("No changes to show yet: this card has no copy of the repository on this Mac.");
    expect(screen.queryByText("Loading the changes…")).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(tauri.callsOf("card_review_diff")).toHaveLength(0);
  });

  it("names the machine as Windows does (n15)", () => {
    setPlatformForTests("windows");
    renderUi(<CardReviewPanel workspaceId={WS} card={card("bare", { worktreePath: null })} />);
    expect(screen.getByText("No changes to show yet: this card has no copy of the repository on this PC.")).toBeTruthy();
  });
});
