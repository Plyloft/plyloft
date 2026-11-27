// CL-3 round 3 (F6): commits came after a review that asked for changes with
// a P1 open — the result still names it, as the last review's, exactly while
// the Inbox counts it (the card at changes requested); otherwise nothing.
import { beforeEach, describe, expect, it } from "vitest";
import { tauri } from "./tauri";
import { OutcomeScreen } from "../components/OutcomeScreen";
import type { BuilderReview, KanbanCard } from "../ipc";
import { useWorkspaces } from "../store/workspaceStore";
import { renderUi, screen, waitFor } from "./render";

const WS = "ws-1";

const review: BuilderReview = {
  snapshotN: 1,
  provider: "codex",
  degraded: false,
  status: "done",
  verdict: "changes_requested",
  at: 2,
  reviewedRevision: "aaa",
  findings: [
    { severity: "P1", title: "Migration deletes user data", body: "", preExisting: false, pass: null, location: "src/migrate.rs:40" },
  ],
};

const card = (reviewStatus: KanbanCard["reviewStatus"]): KanbanCard =>
  ({
    id: "card-1",
    workspaceId: WS,
    title: "Deploy skill",
    columnId: "in_progress",
    lastRunStatus: "success",
    reviewStatus,
    verifyStatus: "passed",
    worktreePath: "/tmp/ply-test/card-1",
    branchName: "card/card-1",
    createdAt: 1,
    updatedAt: 1,
    builder: {
      vendor: "claude",
      bypass: false,
      sessionLost: false,
      startedAt: 1,
      snapshots: [{ n: 1, sha: "aaa", at: 1 }],
      review,
      lastReviewedRevision: "aaa",
    },
  }) as KanbanCard;

function render(c: KanbanCard) {
  useWorkspaces.setState({
    workspaces: [{ id: WS, name: "Ply", cwd: "/tmp/ply-test" } as never],
    activeId: WS,
  });
  return renderUi(
    <OutcomeScreen workspaceId={WS} card={c} reviewTip={{ branchTip: "bbb", commitsSinceReview: 2 }} />,
    {
      fixtures: {
        card_outcome: {
          filesChanged: 1,
          verifyConfigured: false,
          isRecon: false,
          reconVerdictNegative: false,
          reconSummaryMd: null,
          reviewerSource: "challenger",
          reviewerVerdict: "changes_requested",
          reviewerProvider: "codex",
        },
        improvement_proposal_state: null,
        improvement_proposal_trust_stopped: null,
        reviewer_list: [],
        verify_status: null,
        card_overlap_check: [],
        card_review_diff: { cardId: c.id, baseBranch: "staging", cardBranch: "card/card-1", files: [], generatedAt: 1 },
        dependency_doctor: { tools: [], teamSkills: null, projectSkills: null, microphone: null, whisperModel: null },
        kanban_load: [c],
      },
    },
  );
}

// PR #375: the panel reads a Builder card's branch tip (none here).
beforeEach(() => tauri().fixture("card_review_tip", null));

describe("the serious issue on the not-reviewed path (CL-3, F6)", () => {
  it("names the last review's open P1 while the card is at changes requested", async () => {
    const { container } = render(card("changes_requested"));
    await waitFor(() => expect(container.querySelector("[data-ply-review-truth]")).not.toBeNull());
    expect(screen.getByText("From the last review · Serious issue · Migration deletes user data")).toBeTruthy();
  });

  it("draws no callout when the card is not at changes requested", async () => {
    const { container } = render(card("pending"));
    await waitFor(() => expect(container.querySelector("[data-ply-review-truth]")).not.toBeNull());
    expect(container.querySelector("[data-ply-serious-catch]")).toBeNull();
  });
});
