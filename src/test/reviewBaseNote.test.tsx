// Review integrity: when the reviewed range's base was not checked against
// origin's real tip, or a local ref ahead of origin was not used, the card
// says so where the review is shown.
import { describe, expect, it } from "vitest";
import { ChallengerFindings } from "../components/ChallengerFindings";
import type { BuilderReview, KanbanCard } from "../ipc";
import { renderUi } from "./render";

const card: KanbanCard = {
  id: "card-1",
  workspaceId: "ws-1",
  title: "Card",
  columnId: "complete",
  createdAt: 1,
  updatedAt: 1,
};

const review = (extra: Partial<BuilderReview>): BuilderReview => ({
  snapshotN: 1,
  provider: "codex",
  degraded: false,
  status: "done",
  verdict: "approve",
  at: 1,
  ...extra,
});

describe("review base note", () => {
  it("shows the note the review recorded", () => {
    const note = "Local main was ahead of origin; reviewed from the recorded base.";
    const { container } = renderUi(<ChallengerFindings card={card} review={review({ baseNote: note })} />);
    const shown = container.querySelector("[data-ply-review-base-note]");
    // P-D2 Windows walk: plain words first, the recorded note under Details.
    expect(shown?.querySelector("p")?.textContent).toBe(
      "Reviewed from GitHub's copy of the branch: commits that are only on this computer were left out of the comparison. Nothing to do unless the changes look wrong.",
    );
    expect(shown?.querySelector("details")?.textContent).toContain(note);
  });

  it("draws nothing for a verified base or an older review", () => {
    const { container } = renderUi(<ChallengerFindings card={card} review={review({})} />);
    expect(container.querySelector("[data-ply-review-base-note]")).toBeNull();
  });
});
