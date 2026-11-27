// Tier 4 walk 2026-10-14 (n15 re-walk): "The result" offered "Ship as a PR"
// in every state — the tip past the last snapshot, the review running,
// changes requested — with none of the warning the diff panel's "Merge
// anyway" gives; and after a request for changes on a card whose Builder
// session is closed it said they "went to the Builder session" while Now
// said they had not reached it. Both now read the card's own record.
import { beforeEach, describe, expect, it } from "vitest";
import { OutcomeScreen } from "../components/OutcomeScreen";
import type { BuilderReview, KanbanCard } from "../ipc";
import { useWorkspaces } from "../store/workspaceStore";
import { useBuilder } from "../store/builderStore";
import { usePrDraftEarly } from "../store/prDraftEarlyStore";
import { renderUi, screen, tauri } from "./render";

const WS = "ws-1";

const review = (patch: Partial<BuilderReview> = {}): BuilderReview => ({
  snapshotN: 3,
  provider: "codex",
  degraded: false,
  status: "done",
  verdict: "approve",
  reviewedRevision: "c3",
  at: 30,
  ...patch,
});

const card = (r: BuilderReview | null, over: Partial<NonNullable<KanbanCard["builder"]>> = {}): KanbanCard =>
  ({
    id: "card-a",
    workspaceId: WS,
    title: "safeDivide",
    columnId: "in_progress",
    lastRunStatus: "success",
    verifyStatus: "passed",
    reviewStatus: r?.verdict === "changes_requested" ? "changes_requested" : null,
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
      snapshots: [{ n: 3, sha: "c3", at: 3 }],
      review: r,
      ...over,
    },
  }) as KanbanCard;

function render(c: KanbanCard, branchTip: string | null = "c3") {
  useWorkspaces.setState({
    workspaces: [{ id: WS, name: "Ply", cwd: "/tmp/ply-test" } as never],
    activeId: WS,
  });
  return renderUi(
    <OutcomeScreen
      workspaceId={WS}
      card={c}
      reviewTip={branchTip ? { branchTip, commitsSinceReview: 0 } : null}
    />,
    {
      fixtures: {
        card_outcome: {
          filesChanged: 1,
          verifyConfigured: true,
          isRecon: false,
          reconVerdictNegative: false,
          reviewerVerdict: c.builder?.review?.status === "done" ? c.builder.review.verdict : null,
          reviewerSource: "challenger",
          reviewerProvider: "codex",
        },
        improvement_proposal_state: null,
        improvement_proposal_trust_stopped: null,
        reviewer_list: [],
        verify_status: null,
        card_overlap_check: [],
        kanban_load: [c],
        card_review_diff: { cardId: c.id, baseBranch: "main", cardBranch: "plyloft/card-a", files: [], generatedAt: 1 },
      },
    },
  );
}

beforeEach(() => {
  tauri().fixture("card_review_tip", null);
  useBuilder.setState({ verdictDelivery: {} });
});

// 1.171.0 B3 (LG-03, LG-04): The result's pull request in Ship ▾'s words —
// no "Ship as a PR", no "Merge when checks pass" checkbox.
describe("The result's pull request", () => {
  it("is plain past an approved review of the last snapshot: Ship ▾'s two pull request choices", async () => {
    render(card(review()));
    expect(await screen.findByRole("button", { name: "On GitHub, merge when checks pass" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "On GitHub, pull request only (I merge it)" })).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: /Merge when checks pass/ })).toBeNull();
    expect(document.querySelector("[data-ply-ship-gap]")).toBeNull();
  });

  it("says the gap and who merges it on a request for changes", async () => {
    render(card(review({ verdict: "changes_requested" })));
    expect(await screen.findByRole("button", { name: "Open the pull request anyway (I merge it)" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "On GitHub, merge when checks pass" })).toBeNull();
    expect(document.querySelector("[data-ply-ship-gap]")!.textContent).toBe(
      "The Reviewer requested changes on round 3. Open the pull request anyway (I merge it) opens it without an approved review; the receipt and the pull request say so.",
    );
  });

  it("says the gap while the review runs", async () => {
    render(card(review({ status: "running", verdict: null })));
    expect(await screen.findByRole("button", { name: "Open the pull request anyway (I merge it)" })).toBeTruthy();
    expect(document.querySelector("[data-ply-ship-gap]")!.textContent).toMatch(
      /^The Reviewer is still reviewing round 3\./,
    );
  });

  it("is not offered while commits sit past the last snapshot", async () => {
    render(card(review()), "c4");
    expect(await screen.findByText(/A pull request waits for Finish and check/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^(On GitHub|Open the pull request)/ })).toBeNull();
  });
});

describe("where a request for changes went", () => {
  it("says they have not reached the Builder when its session is closed, as Now does", async () => {
    render(
      card(review({ verdict: "changes_requested" }), {
        undeliveredVerdict: { snapshotN: 3, at: 30 },
      }),
    );
    expect(
      await screen.findByText(
        "The Reviewer (Codex) asks for changes; they have not reached the Builder, and its session is closed.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/they went to the Builder session/)).toBeNull();
  });

  it("says they went to the Builder once they did", async () => {
    render(card(review({ verdict: "changes_requested" })));
    expect(
      await screen.findByText("The Reviewer (Codex) asks for changes; they went to the Builder session."),
    ).toBeTruthy();
  });
});

// 1.175.0 F6, walk 6.2: the pull request draft's line is in a build card's
// Review (it was drawn only in an audit card's "Quick wins").
describe("the pull request draft's line in the Review", () => {
  it("says Claude wrote it, with Read it, under the Reviewer's line", async () => {
    usePrDraftEarly.setState({ byCard: { "card-a": { requestId: "r1", commit: "c3", askedAt: 1, ready: true } } });
    try {
      render(card(review()));
      expect(await screen.findByText("Claude wrote the pull request's title and description.")).toBeTruthy();
      const row = document.querySelector("[data-ply-pr-draft-row]")!;
      expect(row.closest("[data-ply-review-part='challenger']")).not.toBeNull();
      expect(screen.getByRole("button", { name: "Read it" })).toBeTruthy();
    } finally {
      usePrDraftEarly.setState({ byCard: {} });
    }
  });
});
