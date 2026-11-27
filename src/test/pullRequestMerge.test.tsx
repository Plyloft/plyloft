// SL-3: Merge from the card, and Merge when checks pass. The card's open PR
// has Merge; a refusal shows Plyloft's line with GitHub's own answer under
// Details; auto-merge on says "Will merge when checks pass." with Turn off;
// GitHub's refusal to turn it on is said in words and Merge stays. 1.171.0
// B3 (CP-6): the workspace's remembered choice is Ship ▾'s first two
// choices — a press on one writes it; no checkbox.
import { describe, expect, it } from "vitest";
import { CardShipStep } from "../components/CardShipStep";
import type { KanbanCard, PrMergeResult, PrStatus } from "../ipc";
import { useKanban } from "../store/kanbanStore";
import { useWorkspaces } from "../store/workspaceStore";
import { CheckLine } from "../components/ux";
import { setPlatformForTests } from "../lib/platform";
import { renderUi, screen, waitFor } from "./render";

const WS = "ws-1";
const URL = "https://github.com/o/r/pull/12";
const BLOCKED =
  "X Pull request o/r#12 is not mergeable: the base branch policy prohibits the merge.";

const pr = (patch: Partial<PrStatus> = {}): PrStatus => ({
  number: 12,
  state: "open",
  checks: "pending",
  checksTotal: 1,
  checksPassed: 0,
  checksPending: 1,
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
  title: "Add sum",
  columnId: "in_progress",
  lastRunStatus: "success",
  verifyStatus: "passed",
  reviewStatus: "merged",
  prUrl: URL,
  pr: pr(),
  worktreePath: "/tmp/ply-test/card-1",
  branchName: "card/card-1",
  createdAt: 1,
  updatedAt: 1,
  ...patch,
});

function seed(c: KanbanCard) {
  useKanban.setState({ byWorkspace: { [WS]: { cards: [c], loaded: true } } } as never);
}

const quiet = { improvement_proposal_state: null, improvement_proposal_trust_stopped: null, ship_pending_release: null };

describe("SL-3: Merge on the card", () => {
  it("merges an open PR through card_pr_merge", async () => {
    const c = card({ pr: pr({ checks: "passing", checksPassed: 1, checksPending: 0 }) });
    seed(c);
    const merged: PrMergeResult = {
      card: { ...c, pr: pr({ state: "merged", checks: "passing" }), shipStatus: "shipped" },
      merged: true,
    };
    const { user, tauri } = renderUi(<CardShipStep card={c} onOpenRelease={() => {}} />, {
      fixtures: { ...quiet, card_pr_refresh: c, card_pr_merge: merged },
    });
    // Checks passed: nothing to wait for, so no auto-merge offer.
    expect(screen.queryByRole("button", { name: "Merge when checks pass" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Merge" }));
    await waitFor(() => expect(tauri.callsOf("card_pr_merge")).toHaveLength(1));
    expect(tauri.callsOf("card_pr_merge")[0].args).toEqual({ workspaceId: WS, cardId: "card-1" });
    expect(screen.queryByText(/Not merged/)).toBeNull();
  });

  it("says beside Merge how the repository merges (G3)", async () => {
    const c = card({ pr: pr({ checks: "passing", checksPassed: 1, checksPending: 0, mergeMethod: "merge" }) });
    seed(c);
    renderUi(<CardShipStep card={c} onOpenRelease={() => {}} />, { fixtures: { ...quiet, card_pr_refresh: c } });
    expect(screen.getByRole("button", { name: "Merge" })).toBeTruthy();
    const hint = document.querySelector("[data-ply-merge-method]");
    expect(hint?.getAttribute("data-ply-merge-method")).toBe("merge");
    expect(hint?.textContent).toBe("Create a merge commit");
  });

  it("says no method before the repository was read", () => {
    const c = card({ pr: pr({ checks: "passing", checksPassed: 1, checksPending: 0 }) });
    seed(c);
    renderUi(<CardShipStep card={c} onOpenRelease={() => {}} />, { fixtures: { ...quiet, card_pr_refresh: c } });
    expect(screen.getByRole("button", { name: "Merge" })).toBeTruthy();
    expect(document.querySelector("[data-ply-merge-method]")).toBeNull();
  });

  it("shows a refusal with GitHub's own answer under Details", async () => {
    // SL-3's rule, kept in Shipping (round 3 review): Merge on pending
    // checks too — GitHub judges, and its answer is shown.
    const c = card();
    seed(c);
    const refused: PrMergeResult = {
      card: c,
      merged: false,
      refused: "Not merged: GitHub says its base branch rules aren't met yet.",
      github: BLOCKED,
    };
    const { user } = renderUi(<CardShipStep card={c} onOpenRelease={() => {}} />, {
      fixtures: { ...quiet, card_pr_refresh: c, card_pr_merge: refused },
    });
    await user.click(screen.getByRole("button", { name: "Merge" }));
    expect(await screen.findByText(/base branch rules aren't met yet/)).toBeTruthy();
    expect(screen.getByText("GitHub's answer")).toBeTruthy();
    expect(screen.getByText(BLOCKED, { exact: false })).toBeTruthy();
  });

  // v1.154.1 (F15): the refusal was about checks that failed; once GitHub
  // says they passed, it goes.
  it("drops a refusal once the pull request reads differently", async () => {
    // Round 3: Merge pressed on passing checks; the fresh read before the
    // merge found a failure (a re-run), and the refusal is about that read.
    const passing = card({ pr: pr({ checks: "passing", checksPassed: 1, checksPending: 0 }) });
    const failing = card({ pr: pr({ checks: "failing", checksPending: 0, failingChecks: [{ name: "test" }] }) });
    seed(passing);
    const refused: PrMergeResult = {
      card: failing,
      merged: false,
      refused: "Not merged: checks failed on GitHub (test). Merge it once they pass.",
    };
    const { user, rerender } = renderUi(<CardShipStep card={passing} onOpenRelease={() => {}} />, {
      fixtures: { ...quiet, card_pr_refresh: passing, card_pr_merge: refused },
    });
    await user.click(screen.getByRole("button", { name: "Merge" }));
    rerender(<CardShipStep card={failing} onOpenRelease={() => {}} />);
    expect(await screen.findByText(/Not merged: checks failed on GitHub/)).toBeTruthy();
    // Round 3: checks failed — no Merge to press again (as in Now).
    expect(screen.queryByRole("button", { name: "Merge" })).toBeNull();
    // A read that changed nothing keeps it.
    rerender(<CardShipStep card={{ ...failing, pr: { ...failing.pr!, checkedAt: 50 } }} onOpenRelease={() => {}} />);
    expect(screen.getByText(/Not merged: checks failed on GitHub/)).toBeTruthy();
    const passed = card({ pr: pr({ checks: "passing", checksPassed: 1, checksPending: 0, checkedAt: 60 }) });
    rerender(<CardShipStep card={passed} onOpenRelease={() => {}} />);
    expect(screen.queryByText(/Not merged: checks failed on GitHub/)).toBeNull();
  });

  it("says auto-merge is on, and turns it off", async () => {
    const c = card({ pr: pr({ autoMerge: true }) });
    seed(c);
    const off: PrMergeResult = { card: card(), merged: false };
    const { user, tauri } = renderUi(<CardShipStep card={c} onOpenRelease={() => {}} />, {
      fixtures: { ...quiet, card_pr_refresh: c, card_pr_set_auto_merge: off },
    });
    expect(screen.getByText(/Will merge when checks pass\./)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Turn off" }));
    await waitFor(() => expect(tauri.callsOf("card_pr_set_auto_merge")).toHaveLength(1));
    expect(tauri.callsOf("card_pr_set_auto_merge")[0].args).toEqual({
      workspaceId: WS,
      cardId: "card-1",
      on: false,
    });
  });

  it("offers to turn it on while checks run", async () => {
    const c = card();
    seed(c);
    const on: PrMergeResult = { card: card({ pr: pr({ autoMerge: true }) }), merged: false };
    const { user, tauri } = renderUi(<CardShipStep card={c} onOpenRelease={() => {}} />, {
      fixtures: { ...quiet, card_pr_refresh: c, card_pr_set_auto_merge: on },
    });
    await user.click(screen.getByRole("button", { name: "Merge when checks pass" }));
    await waitFor(() => expect(tauri.callsOf("card_pr_set_auto_merge")).toHaveLength(1));
    expect(tauri.callsOf("card_pr_set_auto_merge")[0].args).toMatchObject({ on: true });
  });

  it("says plainly when GitHub wouldn't turn it on, and keeps Merge", () => {
    const answer = "GraphQL: Auto merge is not allowed for this repository (enablePullRequestAutoMerge)";
    const c = card({ pr: pr({ autoMergeRefused: answer }) });
    renderUi(<CardShipStep card={c} onOpenRelease={() => {}} />, {
      fixtures: { ...quiet, card_pr_refresh: c },
    });
    expect(screen.getByText(/GitHub doesn't allow merging by itself in this repository; press Merge when it's ready\./)).toBeTruthy();
    expect(screen.getByText(answer)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Merge" })).toBeTruthy();
  });

  it("merged on GitHub but still read open: says so and holds Merge until the next read", async () => {
    const c = card({ pr: pr({ checks: "passing", checksPassed: 1, checksPending: 0 }) });
    seed(c);
    const lagging: PrMergeResult = { card: c, merged: true };
    const { user, tauri, rerender } = renderUi(<CardShipStep card={c} onOpenRelease={() => {}} />, {
      fixtures: { ...quiet, card_pr_refresh: c, card_pr_merge: lagging },
    });
    await user.click(screen.getByRole("button", { name: "Merge" }));
    expect(await screen.findByText("Merged on GitHub; the card updates on its next read.")).toBeTruthy();
    const merge = screen.getByRole("button", { name: "Merge" }) as HTMLButtonElement;
    expect(merge.disabled).toBe(true);
    await user.click(merge);
    expect(tauri.callsOf("card_pr_merge")).toHaveLength(1);
    // A newer read lets it go.
    rerender(<CardShipStep card={card({ pr: pr({ checks: "passing", checkedAt: 9 }) })} onOpenRelease={() => {}} />);
    expect((screen.getByRole("button", { name: "Merge" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(/updates on its next read/)).toBeNull();
  });

  it("GitHub's refusal to turn it on offers Try again", async () => {
    const answer = "GraphQL: Pull request Protected branch rules not configured for this branch (enablePullRequestAutoMerge)";
    const c = card({ pr: pr({ autoMergeRefused: answer }) });
    seed(c);
    const { user, tauri } = renderUi(<CardShipStep card={c} onOpenRelease={() => {}} />, {
      fixtures: { ...quiet, card_pr_refresh: c, card_pr_set_auto_merge: { card: c, merged: false, refused: "x", github: answer } },
    });
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(tauri.callsOf("card_pr_set_auto_merge")).toHaveLength(1));
    expect(tauri.callsOf("card_pr_set_auto_merge")[0].args).toMatchObject({ on: true });
  });

  it("offers no Merge for a merged PR or a card shipped before SL-1", () => {
    const merged = card({ pr: pr({ state: "merged" }), shipStatus: "shipped" });
    const { unmount } = renderUi(<CardShipStep card={merged} onOpenRelease={() => {}} />, { fixtures: quiet });
    expect(screen.queryByRole("button", { name: "Merge" })).toBeNull();
    unmount();
    renderUi(<CardShipStep card={card({ pr: null })} onOpenRelease={() => {}} />, { fixtures: quiet });
    expect(screen.queryByRole("button", { name: "Merge" })).toBeNull();
  });
});

describe("SL-3: Merge when checks pass is remembered for the workspace", () => {
  it("the store saves the choice and keeps it on the workspace", async () => {
    useWorkspaces.setState({
      workspaces: [
        { id: WS, name: "w", cwd: "/tmp/w", createdAt: 1, lastOpenedAt: 1, openFiles: [], activeFile: null },
      ],
    } as never);
    const { tauri } = renderUi(<CheckLine checked={false} onChange={() => {}}>x</CheckLine>, {
      fixtures: { workspace_set_merge_when_checks_pass: null },
    });
    await useWorkspaces.getState().setMergeWhenChecksPass(WS, true);
    expect(tauri.callsOf("workspace_set_merge_when_checks_pass")[0].args).toEqual({ id: WS, on: true });
    expect(useWorkspaces.getState().workspaces[0].mergeWhenChecksPass).toBe(true);
  });

  it("CheckLine is a labelled checkbox", async () => {
    const seen: boolean[] = [];
    const { user } = renderUi(
      <CheckLine checked={false} onChange={(v) => seen.push(v)} hint="Remembered">
        Merge when checks pass
      </CheckLine>,
    );
    await user.click(screen.getByRole("checkbox", { name: "Merge when checks pass" }));
    expect(seen).toEqual([true]);
    expect(screen.getByText("Remembered")).toBeTruthy();
  });

  // CL-11 (Windows walk): the hint said "on this Mac" on Windows.
  it("says this PC on Windows", () => {
    setPlatformForTests("windows");
    try {
      renderUi(
        <CheckLine checked={false} onChange={() => {}} hint="Remembered for this workspace on this Mac.">
          Merge when checks pass
        </CheckLine>,
      );
      expect(screen.getByText("Remembered for this workspace on this PC.")).toBeTruthy();
    } finally {
      setPlatformForTests(null);
    }
  });
});

describe("SL-3, 1.171.0 B3: the workspace's merge when checks pass is Ship ▾'s choice", () => {
  it("only the press that reads it writes it, then ships that way", async () => {
    const { OutcomeScreen } = await import("../components/OutcomeScreen");
    const c: KanbanCard = {
      id: "card-1",
      workspaceId: WS,
      title: "Fix the header",
      columnId: "complete",
      verifyStatus: "passed",
      worktreePath: "/tmp/ply-test/card-1",
      branchName: "card/card-1",
      createdAt: 1,
      updatedAt: 1,
    };
    useWorkspaces.setState({
      workspaces: [{ id: WS, name: "Ply", cwd: "/tmp/ply-test", mergeWhenChecksPass: true } as never],
      activeId: WS,
    });
    const { user, tauri } = renderUi(<OutcomeScreen workspaceId={WS} card={c} />, {
      fixtures: {
        card_outcome: { filesChanged: 2, verifyConfigured: false, isRecon: false, reconVerdictNegative: false },
        improvement_proposal_state: null,
        improvement_proposal_trust_stopped: null,
        reviewer_list: [],
        verify_status: null,
        card_overlap_check: [],
        card_review_diff: { cardId: c.id, baseBranch: "staging", cardBranch: "card/card-1", files: [], generatedAt: 1 },
        dependency_doctor: { tools: [], teamSkills: null, projectSkills: null, microphone: null, whisperModel: null },
        kanban_load: [c],
        workspace_set_merge_when_checks_pass: null,
        card_ship: { kind: "pr", prUrl: "https://github.com/o/r/pull/7", merged: false, conflictingPaths: [], fellBack: false },
      },
    });
    expect(screen.queryByRole("checkbox", { name: "Merge when checks pass" })).toBeNull();
    await user.click(await screen.findByRole("button", { name: "On GitHub, pull request only (I merge it)" }));
    await waitFor(() => expect(tauri.callsOf("card_ship")).toHaveLength(1));
    // Challenger 4: pull request only reads nothing remembered, so writes nothing.
    expect(tauri.callsOf("workspace_set_merge_when_checks_pass")).toHaveLength(0);
    expect(tauri.callsOf("card_ship")[0].args).toMatchObject({ workspaceId: WS, cardId: c.id, mode: "pr_only" });
    // Merge when checks pass on a project kept on this Mac ships as a pull
    // request that follows the remembered choice (`pr`): written on first.
    useWorkspaces.setState({
      workspaces: [{ id: WS, name: "Ply", cwd: "/tmp/ply-test", mergeWhenChecksPass: false, shipVia: "local" } as never],
    });
    await user.click(await screen.findByRole("button", { name: "On GitHub, merge when checks pass" }));
    await waitFor(() => expect(tauri.callsOf("card_ship")).toHaveLength(2));
    expect(tauri.callsOf("workspace_set_merge_when_checks_pass").map((x) => x.args)).toEqual([{ id: WS, on: true }]);
    expect(tauri.callsOf("card_ship")[1].args).toMatchObject({ mode: "pr" });
  });

  // SP-2: when the card's Now holds Ship ▾ with the checkbox, the result
  // does not draw it a second time.
  it("is not drawn in the result when Now's Ship menu holds it", async () => {
    const { OutcomeScreen } = await import("../components/OutcomeScreen");
    const c = { id: "card-1", workspaceId: WS, title: "Fix", columnId: "complete", worktreePath: "/tmp/ply-test/card-1", createdAt: 1, updatedAt: 1 } as KanbanCard;
    useWorkspaces.setState({ workspaces: [{ id: WS, name: "Ply", cwd: "/tmp/ply-test", mergeWhenChecksPass: true } as never], activeId: WS });
    renderUi(<OutcomeScreen workspaceId={WS} card={c} nowOffersShipMenu />, {
      fixtures: {
        card_outcome: { filesChanged: 2, verifyConfigured: false, isRecon: false, reconVerdictNegative: false },
        improvement_proposal_state: null,
        improvement_proposal_trust_stopped: null,
        reviewer_list: [],
        verify_status: null,
        card_overlap_check: [],
        card_review_diff: { cardId: c.id, baseBranch: "staging", cardBranch: "card/card-1", files: [], generatedAt: 1 },
        dependency_doctor: { tools: [], teamSkills: null, projectSkills: null, microphone: null, whisperModel: null },
        kanban_load: [c],
      },
    });
    expect(await screen.findByText(/2 files\s*changed\./)).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "Merge when checks pass" })).toBeNull();
    expect(screen.queryByRole("button", { name: "On GitHub, merge when checks pass" })).toBeNull();
  });

  // 1.170 walk: while a release through a pull request is on its way, the
  // result offers no pull request choice nor Merge when checks pass.
  it("is not drawn in the result while the card is releasing", async () => {
    const { OutcomeScreen } = await import("../components/OutcomeScreen");
    const c = { id: "card-1", workspaceId: WS, title: "Fix", columnId: "complete", worktreePath: "/tmp/ply-test/card-1", createdAt: 1, updatedAt: 1 } as KanbanCard;
    useWorkspaces.setState({ workspaces: [{ id: WS, name: "Ply", cwd: "/tmp/ply-test", mergeWhenChecksPass: true } as never], activeId: WS });
    renderUi(<OutcomeScreen workspaceId={WS} card={c} releasing />, {
      fixtures: {
        card_outcome: { filesChanged: 2, verifyConfigured: false, isRecon: false, reconVerdictNegative: false },
        improvement_proposal_state: null,
        improvement_proposal_trust_stopped: null,
        reviewer_list: [],
        verify_status: null,
        card_overlap_check: [],
        card_review_diff: { cardId: c.id, baseBranch: "staging", cardBranch: "card/card-1", files: [], generatedAt: 1 },
        dependency_doctor: { tools: [], teamSkills: null, projectSkills: null, microphone: null, whisperModel: null },
        kanban_load: [c],
      },
    });
    expect(await screen.findByText(/2 files\s*changed\./)).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "Merge when checks pass" })).toBeNull();
    expect(screen.queryByRole("button", { name: "On GitHub, merge when checks pass" })).toBeNull();
  });
});

// v1.154.1 round 3 (re-walk RW-A): Shipping follows Now's gates.
describe("round 3: Shipping offers Merge only when Now does", () => {
  it("checks failed (a fix under way or not): no Merge, no Merge when checks pass", () => {
    const c = card({ pr: pr({ checks: "failing", checksPending: 0, failingChecks: [{ name: "test" }] }) });
    renderUi(<CardShipStep card={c} onOpenRelease={() => {}} />, { fixtures: { ...quiet, card_pr_refresh: c } });
    expect(screen.getByText(/Pull request #12 is open/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Merge" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Merge when checks pass" })).toBeNull();
    // An open pull request has shipped — as a PR.
    expect(screen.queryByText(/Nothing has shipped yet/)).toBeNull();
  });

  it("a snapshot GitHub doesn't have (the fix before and while it is pushed): no Merge, nothing pressable while pushing", async () => {
    const c = card({
      pr: pr({ checks: "failing", checksPending: 0, failingChecks: [{ name: "test" }], headSha: "aaa" }),
      builder: {
        vendor: "claude",
        bypass: false,
        startedAt: 0,
        ptyId: null,
        snapshots: [
          { n: 1, sha: "aaa", at: 0 },
          { n: 2, sha: "bbb", at: 1 },
        ],
      } as never,
    });
    seed(c);
    let finish: (v: unknown) => void = () => {};
    const { user } = renderUi(<CardShipStep card={c} onOpenRelease={() => {}} />, {
      fixtures: {
        ...quiet,
        card_pr_refresh: c,
        card_pr_push_update: () => new Promise((resolve) => (finish = resolve)),
      },
    });
    expect(screen.queryByRole("button", { name: "Merge" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Send the fixes to GitHub" }));
    const pushing = await screen.findByRole("button", { name: "Sending…" });
    expect((pushing as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Merge" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Merge when checks pass" })).toBeNull();
    finish({ card: c, pushed: true });
  });

  it("the wait for a push's checks: no Merge; Merge when checks pass stays (GitHub waits itself)", () => {
    const c = card({ pr: pr({ checks: "none", checksTotal: 0, checksPending: 0, awaitingChecks: true }) });
    renderUi(<CardShipStep card={c} onOpenRelease={() => {}} />, { fixtures: { ...quiet, card_pr_refresh: c } });
    expect(screen.getByText("Starting on GitHub")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Merge" })).toBeNull();
    expect(screen.getByRole("button", { name: "Merge when checks pass" })).toBeTruthy();
  });
});

describe("G1–G3 Reviewer: commits Plyloft didn't push, and the auto-merge hold", () => {
  const A = "1111111111111111111111111111111111111111";
  const B = "2222222222222222222222222222222222222222";

  it("says the pull request has commits Plyloft didn't push, and merges them only on the person's press", async () => {
    const c = card({
      pr: pr({ checks: "passing", checksPassed: 1, checksPending: 0, pushedHead: A, headSha: B }),
    });
    seed(c);
    const merged: PrMergeResult = {
      card: { ...c, pr: pr({ state: "merged", checks: "passing", headSha: B }), shipStatus: "shipped" },
      merged: true,
    };
    const { user, tauri } = renderUi(<CardShipStep card={c} onOpenRelease={() => {}} />, {
      fixtures: { ...quiet, card_pr_refresh: c, card_pr_merge: merged },
    });
    expect(screen.getByText(/Someone else changed it on GitHub: the pull request has commits Plyloft didn't push\./)).toBeTruthy();
    // 1.171.0 B3 (DL-24): look at them on GitHub — the pull request's own
    // Open on GitHub, once.
    expect(screen.getAllByRole("button", { name: "Open on GitHub" })).toHaveLength(1);
    // No plain Merge, no Merge when checks pass.
    expect(screen.queryByRole("button", { name: "Merge" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Merge when checks pass" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Merge what's on GitHub now" }));
    await waitFor(() => expect(tauri.callsOf("card_pr_merge")).toHaveLength(1));
    expect(tauri.callsOf("card_pr_merge")[0].args).toEqual({ workspaceId: WS, cardId: "card-1", githubHead: B });
  });

  it("says when Merge when checks pass was turned off for an unreviewed commit", () => {
    const c = card({ pr: pr({ autoMergeWanted: "turnedOff" }) });
    seed(c);
    renderUi(<CardShipStep card={c} onOpenRelease={() => {}} />, { fixtures: { ...quiet, card_pr_refresh: c } });
    expect(
      screen.getByText(/^Merge when checks pass was turned off: the last commit isn't reviewed\./),
    ).toBeTruthy();
  });

  it("says when Plyloft turned it on again", () => {
    const c = card({ pr: pr({ autoMerge: true, autoMergeWanted: "resumed" }) });
    seed(c);
    renderUi(<CardShipStep card={c} onOpenRelease={() => {}} />, { fixtures: { ...quiet, card_pr_refresh: c } });
    expect(screen.getByText(/Merge when checks pass is on again: the last commit is reviewed\./)).toBeTruthy();
  });
});
