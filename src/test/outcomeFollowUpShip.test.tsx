// 1.171.0 B3 (CP-14, LG-03): Ship with follow-up sits beside the findings it
// is about — "Ship now, fix these in a new card" — not in the card's ⋯. It
// ships as Ship it would and never merges by itself; on a project kept on
// this Mac that can take a pull request, the pull request is its second way.
// A failure there is reported with its follow-up, so the card's Try again
// keeps it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OutcomeScreen } from "../components/OutcomeScreen";
import type { BuilderReview, KanbanCard } from "../ipc";
import { useWorkspaces } from "../store/workspaceStore";
import { useBuilder } from "../store/builderStore";
import { renderUi, screen, waitFor } from "./render";

const WS = "ws-1";

const finding = {
  id: "F1", severity: "P2", preExisting: false, location: null, title: "F1 title", body: "F1 body",
  reviewId: "r1", round: 1, state: "open", reason: null, updatedRound: 1,
};

const asked = (ledger: unknown[] = [finding]): BuilderReview =>
  ({
    snapshotN: 5,
    provider: "codex",
    degraded: false,
    status: "done",
    verdict: "changes_requested",
    reviewedRevision: "s5",
    at: 30,
    ledger,
  }) as unknown as BuilderReview;

const card = (r: BuilderReview, rounds = 4): KanbanCard =>
  ({
    id: "card-a",
    workspaceId: WS,
    title: "safeDivide",
    columnId: "in_progress",
    lastRunStatus: "success",
    verifyStatus: "passed",
    reviewStatus: "changes_requested",
    worktreePath: "/tmp/ply-test/card-a",
    branchName: "plyloft/card-a",
    createdAt: 1,
    updatedAt: 1,
    builder: {
      vendor: "claude",
      bypass: false,
      ptyId: null,
      sessionLost: false,
      startedAt: 1,
      snapshots: [{ n: 5, sha: "s5", at: 5 }],
      changesRequestedCount: rounds,
      review: r,
    },
  }) as unknown as KanbanCard;

function render(
  c: KanbanCard,
  opts: { hasRemote?: boolean; shipVia?: string | null; onFailure?: (...args: unknown[]) => boolean; ship?: unknown } = {},
) {
  useWorkspaces.setState({
    workspaces: [{ id: WS, name: "Ply", cwd: "/tmp/ply-test", shipVia: opts.shipVia ?? null } as never],
    activeId: WS,
  });
  return renderUi(
    <OutcomeScreen
      workspaceId={WS}
      card={c}
      reviewTip={{ branchTip: "s5", commitsSinceReview: 0 }}
      onFailure={opts.onFailure as never}
    />,
    {
      fixtures: {
        card_outcome: {
          filesChanged: 1,
          verifyConfigured: true,
          isRecon: false,
          reconVerdictNegative: false,
          reviewerVerdict: "changes_requested",
          reviewerSource: "challenger",
          reviewerProvider: "codex",
          hasRemote: opts.hasRemote,
        },
        improvement_proposal_state: null,
        improvement_proposal_trust_stopped: null,
        reviewer_list: [],
        verify_status: null,
        card_overlap_check: [],
        kanban_load: [c],
        card_review_tip: null,
        card_review_diff: { cardId: c.id, baseBranch: "main", cardBranch: "plyloft/card-a", files: [], generatedAt: 1 },
        card_ship_with_follow_up:
          opts.ship ?? { kind: "pr", prUrl: "https://github.com/o/r/pull/9", merged: false, conflictingPaths: [], fellBack: false },
      },
    },
  );
}

const LABEL = "Ship now, fix these in a new card";
const PR_LABEL = "Open the pull request now, fix these in a new card";

beforeEach(() => {
  useBuilder.setState({ verdictDelivery: {} });
});

describe("Ship with follow-up beside the findings (CP-14)", () => {
  it("on GitHub: one press, beside the findings; the pull request leaves the merge to you", async () => {
    const { user, tauri } = render(card(asked()), { hasRemote: true });
    const press = await screen.findByRole("button", { name: LABEL });
    expect(press.closest("[data-ply-follow-up-ship]")).toBeTruthy();
    expect(press.title).toMatch(/leaves the merge to you/);
    expect(screen.queryByRole("button", { name: PR_LABEL })).toBeNull();
    await user.click(press);
    await waitFor(() => expect(tauri.callsOf("card_ship_with_follow_up")).toHaveLength(1));
    expect(tauri.callsOf("card_ship_with_follow_up")[0].args).toMatchObject({ mode: "pr_only" });
  });

  it("kept on this Mac: it lands here, and the pull request is the second way", async () => {
    const { user, tauri } = render(card(asked()), { hasRemote: true, shipVia: "local" });
    await user.click(await screen.findByRole("button", { name: LABEL }));
    await waitFor(() => expect(tauri.callsOf("card_ship_with_follow_up")).toHaveLength(1));
    expect(tauri.callsOf("card_ship_with_follow_up")[0].args).toMatchObject({ mode: "ship_it" });
    await user.click(screen.getByRole("button", { name: PR_LABEL }));
    await waitFor(() => expect(tauri.callsOf("card_ship_with_follow_up")).toHaveLength(2));
    expect(tauri.callsOf("card_ship_with_follow_up")[1].args).toMatchObject({ mode: "pr_only" });
  });

  it("no pull request to open: only the land here", async () => {
    render(card(asked()), { hasRemote: false });
    expect(await screen.findByRole("button", { name: LABEL })).toBeTruthy();
    expect(screen.queryByRole("button", { name: PR_LABEL })).toBeNull();
  });

  it("is not offered before the fourth request for changes", async () => {
    render(card(asked(), 2), { hasRemote: true });
    expect(await screen.findByText(/F1 title/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: LABEL })).toBeNull();
  });

  it("a failure is reported with its follow-up, so Try again keeps it", async () => {
    const onFailure = vi.fn(() => true);
    const { user } = render(card(asked()), {
      hasRemote: true,
      onFailure,
      ship: () => {
        throw new Error("git: remote hung up");
      },
    });
    await user.click(await screen.findByRole("button", { name: LABEL }));
    await waitFor(() => expect(onFailure).toHaveBeenCalledTimes(1));
    expect(onFailure.mock.calls[0]).toEqual(["pr-only", expect.anything(), "card-a", true]);
  });
});
