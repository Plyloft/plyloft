// SL-0 app tester, Ship pilot (2026-09-29): a card shipped as a pull request
// keeps `reviewStatus: "merged"` from the moment its PR opens (the work left
// for the PR). Its result must say what GitHub says about that PR — the walk
// found an open PR reading "Shipped as a pull request, and it was merged."
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OutcomeScreen, PR_OPENED_TOAST_MS } from "../components/OutcomeScreen";
import { CardReviewPanel } from "../components/CardReviewPanel";
import type { KanbanCard, PrStatus } from "../ipc";
import { useWorkspaces } from "../store/workspaceStore";
import { computeTtl, isPersistent, useToasts } from "../store/toastStore";
import { resetBuilderAtDoneForTests } from "../store/builderAtDone";
import { act, renderUi, screen, tauri, waitFor } from "./render";

const WS = "ws-1";

// G11: the close-at-Done watcher and its pending closes are session-wide.
afterEach(() => resetBuilderAtDoneForTests());

const pr = (patch: Partial<PrStatus> = {}): PrStatus => ({
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
  ...patch,
});

const card = (patch: Partial<KanbanCard> = {}): KanbanCard => ({
  id: "card-1",
  workspaceId: WS,
  title: "Tester ship pilot",
  columnId: "in_progress",
  lastRunStatus: "success",
  verifyStatus: "passed",
  reviewStatus: "merged",
  prUrl: "https://github.com/o/r/pull/9",
  pr: pr(),
  worktreePath: "/tmp/ply-test/card-1",
  branchName: "atelier/card-1",
  createdAt: 1,
  updatedAt: 1,
  ...patch,
});

function render(c: KanbanCard) {
  useWorkspaces.setState({
    workspaces: [{ id: WS, name: "Ply", cwd: "/tmp/ply-test" } as never],
    activeId: WS,
  });
  return renderUi(<OutcomeScreen workspaceId={WS} card={c} />, {
    fixtures: {
      card_outcome: { filesChanged: 2, verifyConfigured: true, isRecon: false, reconVerdictNegative: false },
      improvement_proposal_state: null,
      improvement_proposal_trust_stopped: null,
      reviewer_list: [],
      verify_status: null,
      card_overlap_check: [],
      kanban_load: [c],
      card_review_diff: { cardId: c.id, baseBranch: "main", cardBranch: "atelier/card-1", files: [], generatedAt: 1 },
    },
  });
}

// PR #375: the panel reads a Builder card's branch tip (none here).
beforeEach(() => tauri().fixture("card_review_tip", null));

describe("the result of a card shipped as a pull request", () => {
  it("an open pull request reads open, never merged", () => {
    render(card());
    // 1.169.1 (R1): green and mergeable, it is ready to merge.
    // 1.174.0 C5 (T46): merged from the card, or on GitHub.
    expect(screen.getByText("Pull request #9 is ready to merge. Merge it here with Merge, or on GitHub.")).toBeTruthy();
    // The glossary's definition (the help mark's description) is no claim.
    expect(screen.queryByText(/merged/, { ignore: ".ux-term-def" })).toBeNull();
  });

  it("an open pull request keeps the card's changes reachable: See the diff (round 3, RW-A)", async () => {
    render(card());
    const diff = document.querySelector<HTMLDetailsElement>("[data-ply-outcome-diff] > details");
    expect(diff).toBeTruthy();
    expect(screen.getByText("See the changes")).toBeTruthy();
  });

  it("the open pull request's diff: comments to the Builder, no local Merge, no Request changes (Reviewer)", async () => {
    const diff = {
      cardId: "card-1",
      baseBranch: "main",
      cardBranch: "atelier/card-1",
      generatedAt: 1,
      files: [
        {
          path: "sum.js",
          kind: "modified",
          hunks: [
            { header: "@@ -1,2 +1,2 @@", oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, body: "-export function sum(a, b) {\n+export function add(a, b) {\n   return a + b;\n" },
          ],
        },
      ],
    };
    useWorkspaces.setState({ workspaces: [{ id: WS, name: "Ply", cwd: "/tmp/ply-test" } as never], activeId: WS });
    const c = card({ builder: { vendor: "claude", bypass: false, startedAt: 0, snapshots: [{ n: 1, sha: "aaa", at: 1 }], ptyId: null } as never });
    renderUi(<OutcomeScreen workspaceId={WS} card={c} />, {
      fixtures: {
        card_outcome: { filesChanged: 1, verifyConfigured: true, isRecon: false, reconVerdictNegative: false },
        improvement_proposal_state: null,
        improvement_proposal_trust_stopped: null,
        reviewer_list: [],
        verify_status: null,
        card_overlap_check: [],
        kanban_load: [c],
        card_review_diff: diff,
      },
    });
    expect(await screen.findByText("These changes are in pull request #9; comments go to the Builder.")).toBeTruthy();
    expect(screen.getByText("sum.js", { exact: false })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Merge to/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Request changes/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
    expect(screen.queryByText(/nothing is merged until you/)).toBeNull();
    // Its lines can still be picked for a comment to the Builder.
    expect(screen.getAllByRole("option").length).toBeGreaterThan(0);
  });

  it("during a fix round (the review loop's changes_requested), still no local Merge (Reviewer)", async () => {
    const diff = {
      cardId: "card-1", baseBranch: "main", cardBranch: "atelier/card-1", generatedAt: 1,
      files: [{ path: "sum.js", kind: "modified", hunks: [{ header: "@@ -1 +1 @@", oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, body: "-a\n+b\n" }] }],
    };
    const c = card({ reviewStatus: "changes_requested" });
    renderUi(<CardReviewPanel workspaceId={WS} card={c} />, { fixtures: { card_review_diff: diff, kanban_load: [c] } });
    expect(await screen.findByText("These changes are in pull request #9; comments go to the Builder.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Merge to/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Request changes/ })).toBeNull();
  });

  it("a merged pull request has no diff to review", () => {
    render(card({ pr: pr({ state: "merged", mergedAt: 5 }) }));
    expect(document.querySelector("[data-ply-outcome-diff]")).toBeNull();
  });

  it("says merged once GitHub says so", () => {
    render(card({ pr: pr({ state: "merged", mergedAt: 5 }) }));
    expect(screen.getByText("Shipped as pull request #9, and it was merged.")).toBeTruthy();
  });

  it("a pull request never read back (before SL-1) claims no merge", () => {
    render(card({ pr: null }));
    expect(screen.getByText("Its pull request was opened on GitHub.")).toBeTruthy();
    // The glossary's definition (the help mark's description) is no claim.
    expect(screen.queryByText(/merged/, { ignore: ".ux-term-def" })).toBeNull();
  });

  it("a card landed locally still says it landed", () => {
    render(card({ prUrl: null, pr: null }));
    expect(screen.getByText(/^Shipped — it is in .+ on this Mac\.$/)).toBeTruthy();
    expect(screen.queryByText(/target branch/)).toBeNull();
  });
});

// v1.154.1 walk I3 (re-walk R2): after Ship as a PR the pull request is
// only open — a failed check or a review sends a fix to this session. G11
// (1.170.0): nothing asks; the session stays while the pull request is open
// and closes at Done (`builderAtDone.test.tsx`).
describe("the Builder session after Ship as a PR (walk I3, G11)", () => {
  // 1.171.0 B2 (DL-06): where it is and who merges it, in one line.
  const PR_OPENED_LINE = "On GitHub: pull request #9 · you merge it when it's ready, here or on GitHub. You can keep working.";
  function shipAsPr(merges = false, shippedPr: Record<string, unknown> | null = null) {
    let shipped = false;
    const c = card({
      pr: null,
      prUrl: null,
      reviewStatus: null,
      columnId: "complete",
      builder: { vendor: "claude", bypass: false, startedAt: 0, snapshots: [], ptyId: "pty1" } as never,
    });
    useWorkspaces.setState({
      workspaces: [{ id: WS, name: "Ply", cwd: "/tmp/ply-test", mergeWhenChecksPass: merges } as never],
      activeId: WS,
    });
    let runner: ((mode: "merge_live" | "pr") => Promise<void>) | null = null;
    const view = renderUi(
      <OutcomeScreen
        workspaceId={WS}
        card={c}
        onShipReady={(run) => {
          runner = run as typeof runner;
        }}
      />,
      {
        withToasts: true,
        fixtures: {
          card_outcome: { filesChanged: 2, verifyConfigured: true, isRecon: false, reconVerdictNegative: false },
          improvement_proposal_state: null,
          improvement_proposal_trust_stopped: null,
          reviewer_list: [],
          verify_status: null,
          card_overlap_check: [],
          // 1.172.0 B3: after the ship, the card as Ship recorded it.
          kanban_load: () =>
            shipped && shippedPr
              ? [{ ...c, prUrl: "https://github.com/o/r/pull/9", pr: { number: 9, state: "open", ...shippedPr } }]
              : [c],
          card_ship: () => {
            shipped = true;
            return { kind: "pr", prUrl: "https://github.com/o/r/pull/9", merged: false, conflictingPaths: [], fellBack: false };
          },
          builder_close: null,
          card_review_diff: { cardId: "card-1", baseBranch: "main", cardBranch: "atelier/card-1", files: [], generatedAt: 1 },
        },
      },
    );
    return { view, run: async () => {
      await waitFor(() => expect(runner).not.toBeNull());
      void runner!("pr");
    } };
  }

  it("says it merges by itself where it does", async () => {
    const { run } = shipAsPr(true);
    await run();
    await waitFor(() =>
      expect(useToasts.getState().toasts.map((t) => t.title)).toContain(
        "On GitHub: pull request #9 · it merges by itself once GitHub's checks pass. You can keep working.",
      ),
    );
  });

  // 1.172.0 B3 (B2 Challenger leftover): where the base branch requires no
  // checks Plyloft keeps the merge, only while it's open; where GitHub
  // refused its auto-merge, the person merges it.
  it("says Plyloft merges it while it's open where Plyloft keeps the merge", async () => {
    const { run } = shipAsPr(true, { plyloftAutoMerge: true });
    await run();
    await waitFor(() =>
      expect(useToasts.getState().toasts.map((t) => t.title)).toContain(
        "On GitHub: pull request #9 · Plyloft merges it once GitHub's checks pass, while it's open on this Mac. You can keep working.",
      ),
    );
  });

  it("says the person merges it where GitHub refused its auto-merge", async () => {
    const { run } = shipAsPr(true, { autoMerge: false, autoMergeRefused: "auto-merge is not allowed for this repository" });
    await run();
    await waitFor(() => expect(useToasts.getState().toasts.some((t) => t.title === PR_OPENED_LINE)).toBe(true));
  });

  it("asks nothing and keeps the session open while the pull request is open", async () => {
    const { run } = shipAsPr();
    await run();
    await waitFor(() => expect(useToasts.getState().toasts.some((t) => t.title === PR_OPENED_LINE)).toBe(true));
    // 1.170.0 walk fix: it times out like the others, its Open on GitHub kept.
    const opened = useToasts.getState().toasts.find((t) => t.title === PR_OPENED_LINE)!;
    expect(opened.action?.label).toBe("Open on GitHub");
    // 1.171.0 B2 (DL-06): no bare link, no "last build".
    expect(opened.body).toBeUndefined();
    expect(computeTtl(opened)).toBe(PR_OPENED_TOAST_MS);
    expect(isPersistent(opened)).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText(/Keep this card's Builder session open/)).toBeNull();
    expect(useToasts.getState().toasts.find((t) => t.title.endsWith("so its Builder session was closed."))).toBeUndefined();
    expect(tauri().callsOf("builder_close")).toHaveLength(0);
  });
});

// Windows walk 2026-10-20 (Try it re-walk): after a local Ship the card's
// copy is removed — on Windows, kept until the session closes. G11
// (1.170.0): nothing asks; the session closes at once, with Undo in the
// toast (the close itself waits for the toast, `builderAtDone.test.tsx`).
describe("the Builder session after a local Ship (Windows walk 2026-10-20, G11)", () => {
  function shipLocal(after: Partial<KanbanCard>) {
    const before = card({
      pr: null,
      prUrl: null,
      reviewStatus: null,
      columnId: "complete",
      builder: { vendor: "claude", bypass: false, startedAt: 0, snapshots: [], ptyId: "pty1" } as never,
    });
    useWorkspaces.setState({ workspaces: [{ id: WS, name: "Ply", cwd: "/tmp/ply-test" } as never], activeId: WS });
    let runner: ((mode: "merge_live" | "pr") => Promise<void>) | null = null;
    const view = renderUi(
      <OutcomeScreen workspaceId={WS} card={before} onShipReady={(run) => (runner = run as typeof runner)} />,
      {
        withToasts: true,
        fixtures: {
          card_outcome: { filesChanged: 2, verifyConfigured: true, isRecon: false, reconVerdictNegative: false },
          improvement_proposal_state: null,
          improvement_proposal_trust_stopped: null,
          reviewer_list: [],
          verify_status: null,
          card_overlap_check: [],
          kanban_load: [{ ...before, shipStatus: "shipped", ...after }],
          card_ship: { kind: "local_merge", merged: true, conflictingPaths: [], fellBack: false },
          builder_close: null,
          card_review_diff: { cardId: "card-1", baseBranch: "main", cardBranch: "atelier/card-1", files: [], generatedAt: 1 },
        },
      },
    );
    view.tauri.allowUnhandled();
    return async () => {
      await waitFor(() => expect(runner).not.toBeNull());
      void runner!("merge_live");
      // The ship's own line is read first: the session's toast waits for it.
      await waitFor(() => expect(useToasts.getState().toasts.some((t) => t.title === "Shipped")).toBe(true));
      expect(useToasts.getState().toasts.some((t) => t.title.endsWith("so its Builder session was closed."))).toBe(false);
      act(() => useToasts.getState().dismiss(useToasts.getState().toasts[0].id));
      await waitFor(() =>
        expect(useToasts.getState().toasts.some((t) => t.title.endsWith("so its Builder session was closed."))).toBe(true),
      );
      return view;
    };
  }

  it("asks nothing: Closed the Builder session, with Undo", async () => {
    const view = await shipLocal({ keptCopy: { path: "C:\\r\\.plyloft-worktrees\\c1", reason: "os error 32", at: 1 } as never })();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText(/Close this card's Builder session/)).toBeNull();
    const toast = useToasts.getState().toasts.find((t) => t.title.endsWith("so its Builder session was closed."))!;
    // 1.171.0 B2 (DL-37): it names the card.
    expect(toast.title).toBe("“Tester ship pilot” shipped, so its Builder session was closed.");
    expect(toast.action?.label).toBe("Undo");
    // Undo keeps it: nothing closes.
    await view.user.click(screen.getByRole("button", { name: "Undo" }));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(tauri().callsOf("builder_close")).toHaveLength(0);
  });
});
