// Tier 4 walk 2026-10-14: after "Review again" took snapshot #2 (a new
// commit adding `max`), the card's diff still showed snapshot #1 — and
// offered to merge it — because the read was keyed on the review status
// alone, which a Builder card's new snapshot leaves unchanged. The diff now
// follows the card's revision: a new snapshot, a new review or a branch tip
// past the last Build done reads it again, and the old answer is never
// shown, nor merged, as the new one's.
//
// PR #375 review: Merge lands only the last snapshot (commits past it wait
// for Build done), plainly only past an approved review (else "Merge
// anyway", sent as `unreviewedOk`), and a new read keeps the member's
// verdicts on the hunks it still shows unchanged.
import { beforeEach, describe, expect, it } from "vitest";
import { CardReviewPanel, keptVerdicts, reviewDiffKey } from "../components/CardReviewPanel";
import { mergeReviewGap } from "../lib/challengerReview";
import type { BuilderReview, BuildSnapshot, KanbanCard, ReviewDiff } from "../ipc";
import { renderUi, screen, waitFor } from "./render";
import { tauri } from "./tauri";
import { useToasts } from "../store/toastStore";

const WS = "ws-1";

const snap = (n: number, sha: string): BuildSnapshot => ({ n, sha, at: n });
const approved = (n: number, sha: string): BuilderReview => ({
  snapshotN: n,
  provider: "codex",
  degraded: false,
  status: "done",
  verdict: "approve",
  reviewId: `r${n}`,
  reviewedRevision: sha,
  at: n,
});

const card = (
  snapshots: BuildSnapshot[],
  review: BuilderReview | null = snapshots.length ? approved(snapshots[snapshots.length - 1].n, snapshots[snapshots.length - 1].sha) : null,
  over: Partial<KanbanCard> = {},
): KanbanCard =>
  ({
    id: "card-a",
    workspaceId: WS,
    title: "Card A",
    columnId: "in_progress",
    worktreePath: "/tmp/ply-test/card-a",
    branchName: "card/card-a",
    reviewStatus: null,
    builder: { vendor: "claude", bypass: false, ptyId: "p", sessionLost: false, startedAt: 1, snapshots, review },
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }) as KanbanCard;

const SAFE_DIVIDE = "+export function safeDivide(a, b) {\n+  return b === 0 ? 0 : a / b;\n+}\n";
const MAX = "+export function max(a, b) {\n+  return a < b ? a : b;\n+}\n";

const diffOf = (body: string, second?: string): ReviewDiff => ({
  cardId: "card-a",
  baseBranch: "main",
  cardBranch: "card/card-a",
  generatedAt: 1,
  files: [
    {
      path: "sum.js",
      kind: "modified",
      hunks: [
        { header: "@@ -31,0 +32,3 @@", oldStart: 31, oldLines: 0, newStart: 32, newLines: 3, body },
        ...(second
          ? [{ header: "@@ -38,0 +39,3 @@", oldStart: 38, oldLines: 0, newStart: 39, newLines: 3, body: second }]
          : []),
      ],
    },
  ],
});

/** The worktree as the backend reads it: whatever was last committed. */
function worktree(initial: ReviewDiff) {
  const state = { diff: initial, reads: 0 };
  return {
    state,
    fixture: () => {
      state.reads += 1;
      return state.diff;
    },
  };
}

beforeEach(() => tauri().fixture("card_review_tip", null));

describe("the review diff follows the card's revision", () => {
  it("keys on the latest snapshot, the review and a tip past the snapshot", () => {
    const one = card([snap(1, "41cfaf7")]);
    const two = card([snap(1, "41cfaf7"), snap(2, "f71cb69")], null);
    expect(reviewDiffKey(one)).not.toBe(reviewDiffKey(two));
    expect(reviewDiffKey(two)).toBe(reviewDiffKey(card([snap(1, "41cfaf7"), snap(2, "f71cb69")], null)));
    const reviewed = card([snap(1, "41cfaf7"), snap(2, "f71cb69")]);
    expect(reviewDiffKey(reviewed)).not.toBe(reviewDiffKey(two));
    // The tip at the snapshot adds nothing (its first read doesn't refetch);
    // a tip past it does.
    expect(reviewDiffKey(reviewed, "f71cb69")).toBe(reviewDiffKey(reviewed));
    expect(reviewDiffKey(reviewed, "abc1234")).not.toBe(reviewDiffKey(reviewed));
  });

  it("reads the diff again on a new snapshot with the review status unchanged", async () => {
    const wt = worktree(diffOf(SAFE_DIVIDE));
    const { rerender } = renderUi(<CardReviewPanel workspaceId={WS} card={card([snap(1, "41cfaf7")])} />, {
      fixtures: { card_review_diff: wt.fixture },
    });
    expect(await screen.findByText(/safeDivide/)).toBeTruthy();
    // G10: the panel has no Merge of its own; Now's Ship ships the card.
    expect(screen.queryByRole("button", { name: /Merge/ })).toBeNull();
    expect(wt.state.reads).toBe(1);

    // A new commit; Review again records snapshot #2. reviewStatus stays null.
    wt.state.diff = diffOf(SAFE_DIVIDE, MAX);
    rerender(<CardReviewPanel workspaceId={WS} card={card([snap(1, "41cfaf7"), snap(2, "f71cb69")])} />);
    // Until the new read lands, snapshot #1's diff is not shown as current
    // and nothing offers to merge it.
    expect(screen.queryByText(/function max/)).toBeNull();
    expect(screen.getByText("Loading the changes…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Merge/ })).toBeNull();

    expect(await screen.findByText(/function max/)).toBeTruthy();
    expect(wt.state.reads).toBe(2);
    expect(screen.queryByRole("button", { name: /Merge/ })).toBeNull();
  });

  // Skills hub H3a, Mac walk 2: Refresh card rebuilt the skill card's commit
  // at the library's new version, and the diff kept showing the old one.
  it("reads a skill card's diff again once Refresh card moved its version", async () => {
    const skill = (contentId: string): KanbanCard =>
      card([], null, {
        builder: undefined,
        columnId: "complete",
        kind: {
          type: "skill",
          verb: "update",
          skill: "team-style",
          origin: {
            kind: "team",
            source: "acme/team",
            name: "team-style",
            version: { commit: `c-${contentId}`, contentId },
          },
        },
      });
    expect(reviewDiffKey(skill("ruby"))).not.toBe(reviewDiffKey(skill("jade")));
    const wt = worktree(diffOf("+RUBY-12\n"));
    const { rerender } = renderUi(<CardReviewPanel workspaceId={WS} card={skill("ruby")} />, {
      fixtures: { card_review_diff: wt.fixture },
    });
    expect(await screen.findByText(/RUBY-12/)).toBeTruthy();
    wt.state.diff = diffOf("+JADE-13\n");
    rerender(<CardReviewPanel workspaceId={WS} card={skill("jade")} />);
    expect(await screen.findByText(/JADE-13/)).toBeTruthy();
    expect(screen.queryByText(/RUBY-12/)).toBeNull();
    expect(wt.state.reads).toBe(2);
  });

  it("does not read again when nothing about the revision moved", async () => {
    const wt = worktree(diffOf(SAFE_DIVIDE));
    const c = card([snap(1, "41cfaf7")]);
    const { rerender } = renderUi(<CardReviewPanel workspaceId={WS} card={c} />, {
      fixtures: { card_review_diff: wt.fixture },
    });
    await screen.findByText(/safeDivide/);
    rerender(<CardReviewPanel workspaceId={WS} card={{ ...c, updatedAt: 99 }} />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(wt.state.reads).toBe(1);
  });

  it("reads again in the card page's kept mount: hidden, a new snapshot, shown again", async () => {
    // The card host stays mounted while the member is on the Board; the
    // panel is hidden, not unmounted, and must not come back stale.
    const wt = worktree(diffOf(SAFE_DIVIDE));
    const page = (c: KanbanCard, hidden: boolean) => (
      <div className={hidden ? "center-card-host hidden" : "center-card-host"}>
        <CardReviewPanel workspaceId={WS} card={c} />
      </div>
    );
    const { rerender } = renderUi(page(card([snap(1, "41cfaf7")]), false), {
      fixtures: { card_review_diff: wt.fixture },
    });
    await screen.findByText(/safeDivide/);
    rerender(page(card([snap(1, "41cfaf7")]), true));
    wt.state.diff = diffOf(SAFE_DIVIDE, MAX);
    rerender(page(card([snap(1, "41cfaf7"), snap(2, "f71cb69")]), true));
    rerender(page(card([snap(1, "41cfaf7"), snap(2, "f71cb69")]), false));
    expect(await screen.findByText(/function max/)).toBeTruthy();
    expect(wt.state.reads).toBe(2);
  });

  it("reads again when the tip moves past the last Build done, and offers no Merge", async () => {
    tauri().fixture("card_review_tip", { branchTip: "abc1234", commitsSinceReview: 1 });
    const wt = worktree(diffOf(SAFE_DIVIDE, MAX));
    renderUi(<CardReviewPanel workspaceId={WS} card={card([snap(1, "41cfaf7")])} />, {
      fixtures: { card_review_diff: wt.fixture },
    });
    expect(await screen.findByText(/function max/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Merge/ })).toBeNull();
  });

  it("keeps the verdicts on hunks a new read still shows unchanged", async () => {
    const wt = worktree(diffOf(SAFE_DIVIDE));
    const { rerender, user } = renderUi(<CardReviewPanel workspaceId={WS} card={card([snap(1, "41cfaf7")])} />, {
      fixtures: { card_review_diff: wt.fixture },
    });
    await screen.findByText(/safeDivide/);
    await user.click(screen.getByRole("button", { name: "Accept" }));
    expect(document.querySelectorAll(".verdict-accepted")).toHaveLength(1);
    wt.state.diff = diffOf(SAFE_DIVIDE, MAX);
    rerender(<CardReviewPanel workspaceId={WS} card={card([snap(1, "41cfaf7"), snap(2, "f71cb69")])} />);
    await screen.findByText(/function max/);
    // safeDivide's hunk is the same: still accepted; max's is new.
    expect(document.querySelectorAll(".verdict-accepted")).toHaveLength(1);
    expect(document.querySelectorAll(".verdict-none")).toHaveLength(1);
  });

  it("keptVerdicts drops a changed hunk and another card's verdicts", () => {
    const before = diffOf(SAFE_DIVIDE);
    const key = `sum.js\u0000@@ -31,0 +32,3 @@`;
    expect(keptVerdicts({ [key]: 1 }, before, diffOf(SAFE_DIVIDE, MAX))).toEqual({ [key]: 1 });
    expect(keptVerdicts({ [key]: 1 }, before, diffOf(MAX))).toEqual({});
    expect(keptVerdicts({ [key]: 1 }, before, { ...diffOf(SAFE_DIVIDE), cardId: "card-b" })).toEqual({});
    expect(keptVerdicts({ [key]: 1 }, null, diffOf(SAFE_DIVIDE))).toEqual({});
  });
});

describe("the panel's Merge and the Reviewer (PR #375 review)", () => {
  it("names why a snapshot isn't approved, and nothing for an approved one", () => {
    const s = [snap(1, "a"), snap(2, "b")];
    expect(mergeReviewGap(card(s).builder)).toBeNull();
    expect(mergeReviewGap(card(s, null).builder)).toMatch(/has not reviewed round 2/);
    expect(mergeReviewGap(card(s, approved(1, "a")).builder)).not.toBeNull();
    expect(mergeReviewGap(card(s, { ...approved(2, "b"), status: "running", verdict: null }).builder)).toMatch(
      /still reviewing round 2/,
    );
    expect(mergeReviewGap(card(s, { ...approved(2, "b"), status: "failed", verdict: null }).builder)).not.toBeNull();
    expect(mergeReviewGap(card(s, { ...approved(2, "b"), verdict: "changes_requested" }).builder)).toMatch(
      /requested changes on round 2/,
    );
    expect(mergeReviewGap(card(s, { ...approved(2, "b"), verdict: "incomplete" }).builder)).toMatch(/incomplete/);
    // An accepted pushback stands, as at Ship; 1.171.0 C3 (owner
    // 2026-10-27): a review skipped on purpose is no review.
    expect(mergeReviewGap(card(s, { ...approved(2, "b"), status: "skipped", verdict: null, note: "overridden" }).builder)).toBeNull();
    expect(mergeReviewGap(card(s, { ...approved(2, "b"), status: "skipped", verdict: null }).builder)).toBe(
      "You skipped the review of the last round.",
    );
    expect(mergeReviewGap(null)).toBeNull();
    // A skip stands for its own snapshot only (as the backend counts it).
    expect(mergeReviewGap(card(s, { ...approved(1, "a"), status: "skipped", verdict: null }).builder)).toMatch(
      /has not reviewed round 2/,
    );
    expect(
      mergeReviewGap(card(s, { ...approved(1, "a"), status: "skipped", verdict: null, note: "overridden" }).builder),
    ).toMatch(/has not reviewed round 2/);
  });

  it("retries a conflicted merge the same way: Retry merge anyway sends that choice", async () => {
    tauri().allowUnhandled();
    const unapproved = card([snap(1, "41cfaf7")], null, { reviewStatus: "conflict_blocked" });
    const { user, rerender } = renderUi(<CardReviewPanel workspaceId={WS} card={unapproved} />, {
      fixtures: {
        card_review_diff: diffOf(SAFE_DIVIDE),
        card_review_merge: { merged: false, conflictingPaths: ["sum.js"] },
      },
    });
    expect(screen.getByText(/has not reviewed round 1\. Retry merge anyway lands it/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Retry merge anyway" }));
    await waitFor(() => expect(tauri().callsOf("card_review_merge")).toHaveLength(1));
    expect(tauri().callsOf("card_review_merge")[0].args.unreviewedOk).toBe(true);

    // Approved: a plain retry.
    rerender(<CardReviewPanel workspaceId={WS} card={card([snap(1, "41cfaf7")], undefined, { reviewStatus: "conflict_blocked" })} />);
    await user.click(screen.getByRole("button", { name: "Retry merge" }));
    await waitFor(() => expect(tauri().callsOf("card_review_merge")).toHaveLength(2));
    expect(tauri().callsOf("card_review_merge")[1].args.unreviewedOk).toBe(false);
  });

  it("says the human's decision on the review when a retried merge ships", async () => {
    tauri().allowUnhandled();
    const c = card([snap(1, "41cfaf7")], undefined, { reviewStatus: "conflict_blocked" });
    const { user } = renderUi(<CardReviewPanel workspaceId={WS} card={c} />, {
      fixtures: {
        card_review_diff: diffOf(SAFE_DIVIDE),
        card_review_merge: {
          merged: true,
          conflictingPaths: [],
          reviewOverride: "Codex requested changes on snapshot 1; overridden by the human.",
        },
      },
    });
    await user.click(screen.getByRole("button", { name: "Retry merge" }));
    // G10: one verb, and the target by its name on this Mac.
    await waitFor(() =>
      expect(useToasts.getState().toasts.find((t) => t.title === "Shipped")?.body).toBe(
        "Merged into main on this Mac. Codex requested changes on snapshot 1; overridden by the human.",
      ),
    );
  });

  it("offers no Merge of its own, approved or not: Now's Ship ships the card (G10)", async () => {
    const approvedCard = card([snap(1, "41cfaf7")]);
    const { rerender } = renderUi(<CardReviewPanel workspaceId={WS} card={approvedCard} />, {
      fixtures: { card_review_diff: diffOf(SAFE_DIVIDE) },
    });
    await screen.findByText(/safeDivide/);
    expect(screen.getByRole("button", { name: /^Request changes/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Merge/ })).toBeNull();
    const unapproved = card([snap(1, "41cfaf7"), snap(2, "f71cb69")], { ...approved(2, "f71cb69"), verdict: "changes_requested" });
    rerender(<CardReviewPanel workspaceId={WS} card={unapproved} />);
    await screen.findByText(/safeDivide/);
    expect(screen.queryByRole("button", { name: /Merge/ })).toBeNull();
    expect(screen.queryByText(/Merge anyway lands it/)).toBeNull();
    expect(screen.getByText(/nothing is merged until you\s+ship it/)).toBeTruthy();
  });
});
