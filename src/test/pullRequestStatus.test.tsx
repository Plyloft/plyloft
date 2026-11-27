// SL-1: the card's pull request, read back from GitHub, in the Shipping
// section. An open PR is read when the page opens and on Refresh; its checks
// are "Checks on GitHub"; a request for changes shows its text; a failed
// Refresh says so without losing what the card last read; a card shipped as a
// PR before SL-1 is read only on Refresh.
import { describe, expect, it } from "vitest";
import { CardShipStep } from "../components/CardShipStep";
import type { KanbanCard, PrStatus } from "../ipc";
import { useKanban } from "../store/kanbanStore";
import { renderUi, screen, waitFor } from "./render";
import { setPlatformForTests } from "../lib/platform";

const WS = "ws-1";
const URL = "https://github.com/o/r/pull/12";

const pr = (patch: Partial<PrStatus> = {}): PrStatus => ({
  number: 12,
  state: "open",
  checks: "pending",
  checksTotal: 2,
  checksPassed: 1,
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

const quiet = {
  improvement_proposal_state: null,
  improvement_proposal_trust_stopped: null,
  ship_pending_release: null,
  // Try it TI-5: a merged pull request's receipt asks for the start command
  // (none here, so it asks nothing more).
  project_try_command_get: { command: null, approved: true, shared: false, readOnly: false, hasConfig: true, detection: { kind: "none" } },
};

describe("SL-1: the pull request on the card", () => {
  it("reads an open PR when the page opens and shows its checks on GitHub", async () => {
    const failing = card({
      pr: pr({ checks: "failing", checksPending: 0, failingChecks: [{ name: "test", url: "https://ci/1" }] }),
    });
    seed(card());
    const { tauri, rerender } = renderUi(<CardShipStep card={card()} onOpenRelease={() => {}} />, {
      fixtures: { ...quiet, card_pr_refresh: failing },
    });
    await waitFor(() => expect(tauri.callsOf("card_pr_refresh")).toHaveLength(1));
    expect(tauri.callsOf("card_pr_refresh")[0].args).toEqual({ workspaceId: WS, cardId: "card-1" });
    expect(screen.getByText(/Checks on GitHub:/)).toBeTruthy();
    expect(screen.getByText("Running · 1 of 2 done")).toBeTruthy();

    rerender(<CardShipStep card={failing} onOpenRelease={() => {}} />);
    expect(screen.getByText("Failed · test")).toBeTruthy();
    expect(screen.getByText("Pull request #12 is open: checks failed on GitHub.")).toBeTruthy();
    // Opened once per card page, not on every read it causes.
    expect(tauri.callsOf("card_pr_refresh")).toHaveLength(1);
  });

  it("QoL 14.2 (C21): the pull request opens on GitHub from its card", async () => {
    const c = card();
    seed(c);
    const { user, tauri } = renderUi(<CardShipStep card={c} onOpenRelease={() => {}} />, {
      fixtures: { ...quiet, card_pr_refresh: c, open_web_link: null },
    });
    await user.click(screen.getByRole("button", { name: "Open on GitHub" }));
    await waitFor(() => expect(tauri.callsOf("open_web_link")[0]?.args).toEqual({ url: c.prUrl }));
  });

  it("shows a request for changes with its text, and a conflict", () => {
    const c = card({
      pr: pr({
        checks: "passing",
        reviewDecision: "changes_requested",
        changesRequested: { author: "octo", body: "Please rename sum to add.", submittedAt: 5 },
        mergeable: "conflicting",
      }),
    });
    renderUi(<CardShipStep card={c} onOpenRelease={() => {}} />, {
      fixtures: { ...quiet, card_pr_refresh: c },
    });
    expect(screen.getByText("octo asked for changes on GitHub:")).toBeTruthy();
    expect(screen.getByText("Please rename sum to add.")).toBeTruthy();
    expect(screen.getByText("It conflicts with its base branch, so GitHub can't merge it.")).toBeTruthy();
  });

  it("says a failed Refresh in words and keeps what the card last read", async () => {
    const c = card({ pr: pr({ checks: "passing" }) });
    seed(c);
    const { user, tauri } = renderUi(<CardShipStep card={c} onOpenRelease={() => {}} />, {
      fixtures: {
        ...quiet,
        card_pr_refresh: () => {
          throw "couldn't read the pull request on GitHub: HTTP 502";
        },
      },
    });
    await waitFor(() => expect(tauri.callsOf("card_pr_refresh")).toHaveLength(1));
    // The read on open failed quietly.
    expect(screen.queryByText(/Couldn't read the pull request/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText(/Couldn't read the pull request from GitHub/)).toBeTruthy();
    expect(screen.getByText("Passed")).toBeTruthy();
  });

  // 1.172.0 (D2): on a shipped card the ship step sits inside What shipped,
  // whose own line says it shipped and merged, so the step's headline is
  // not drawn a second time (shippedResult.test.tsx pins What shipped).
  it("merged: says why the worktree was kept, without repeating What shipped's line; no Refresh", () => {
    const c = card({
      pr: pr({ state: "merged", checks: "passing", cleanupKept: "its Builder session is open" }),
      shipStatus: "shipped",
    });
    const { tauri } = renderUi(<CardShipStep card={c} onOpenRelease={() => {}} />, { fixtures: quiet });
    expect(screen.queryByText("Shipped as pull request #12, and it was merged.")).toBeNull();
    expect(screen.getByText("The card's copy of the repository was kept: its Builder session is open.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
    expect(tauri.callsOf("card_pr_refresh")).toHaveLength(0);
  });

  // X5 (G1 walk): the copy removed since — Done, Cards' copies, its session
  // closing — leaves no "was kept" line, however the pull request read.
  it("merged, the card's copy gone: no line says it was kept", () => {
    const c = card({
      pr: pr({ state: "merged", checks: "passing", cleanupKept: "its Builder session is open" }),
      shipStatus: "shipped",
      worktreePath: null,
    });
    renderUi(<CardShipStep card={c} onOpenRelease={() => {}} />, { fixtures: quiet });
    expect(screen.queryByText(/copy of the repository was kept/)).toBeNull();
    expect(document.querySelector("[data-ply-copy-kept]")).toBeNull();
  });

  // G5: merged, but this computer's target branch stayed behind GitHub's.
  it("merged: offers Bring this Mac up to date, with the reason", async () => {
    const c = card({
      columnId: "complete",
      pr: pr({ state: "merged", checks: "passing", upToDateRefused: "You have changes that aren't in a commit" }),
      shipStatus: "shipped",
    });
    seed(c);
    const up = { ...c, pr: { ...c.pr!, upToDateRefused: null } };
    const { user, tauri } = renderUi(<CardShipStep card={c} onOpenRelease={() => {}} />, {
      fixtures: { ...quiet, card_bring_up_to_date: { card: up, refused: null } },
    });
    expect(
      screen.getByText(/^Merged\. You have changes that aren't in a commit, so this Mac wasn't brought up to date\./),
    ).toBeTruthy();
    tauri.allowUnhandled();
    await user.click(screen.getByRole("button", { name: "Bring this Mac up to date" }));
    await waitFor(() =>
      expect(tauri.callsOf("card_bring_up_to_date")[0]?.args).toEqual({ workspaceId: WS, cardId: "card-1" }),
    );
    await waitFor(() => expect(useKanban.getState().byWorkspace[WS].cards[0].pr?.upToDateRefused).toBeNull());
  });

  // 1.174.1 P5 (T5): this PC on Windows.
  it("merged, on Windows: Bring this PC up to date", () => {
    const c = card({
      columnId: "complete",
      pr: pr({ state: "merged", checks: "passing", upToDateRefused: "You have changes that aren't in a commit" }),
      shipStatus: "shipped",
    });
    seed(c);
    setPlatformForTests("windows");
    try {
      renderUi(<CardShipStep card={c} onOpenRelease={() => {}} />, { fixtures: quiet });
      expect(screen.getByText(/so this PC wasn't brought up to date\./)).toBeTruthy();
      expect(screen.getByRole("button", { name: "Bring this PC up to date" })).toBeTruthy();
    } finally {
      setPlatformForTests(null);
    }
  });

  // G5 (Challenger 4, 7): commits of its own — the words, no button; the
  // branch left on GitHub says why in a muted line.
  it("merged with commits of its own: says what to do, no button; the kept branch's reason", () => {
    const c = card({
      columnId: "complete",
      pr: pr({
        state: "merged",
        checks: "passing",
        upToDateRefused: "This computer's main has commits GitHub's doesn't — ship or move them first.",
        upToDateNoPress: true,
        branchKept: "another open pull request uses plyloft/card-1",
      }),
      shipStatus: "shipped",
    });
    renderUi(<CardShipStep card={c} onOpenRelease={() => {}} />, { fixtures: quiet });
    expect(screen.getByText("Merged. This computer's main has commits GitHub's doesn't — ship or move them first.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Bring this Mac up to date" })).toBeNull();
    expect(
      screen.getByText("The pull request's branch was left on GitHub: another open pull request uses plyloft/card-1."),
    ).toBeTruthy();
  });

  it("merged and up to date: offers nothing more", () => {
    const c = card({ pr: pr({ state: "merged", checks: "passing" }), shipStatus: "shipped" });
    renderUi(<CardShipStep card={c} onOpenRelease={() => {}} />, { fixtures: quiet });
    expect(screen.queryByRole("button", { name: "Bring this Mac up to date" })).toBeNull();
  });

  it("closed without merging: back to review, the worktree kept", () => {
    const c = card({ pr: pr({ state: "closed", closedAt: 9 }), reviewStatus: "pending" });
    const { tauri } = renderUi(<CardShipStep card={c} onOpenRelease={() => {}} />, { fixtures: quiet });
    expect(screen.getByText(/Pull request #12 was closed without merging\. The card's copy and its branch are kept/)).toBeTruthy();
    expect(tauri.callsOf("card_pr_refresh")).toHaveLength(0);
  });

  it("a card shipped as a PR before SL-1 claims no merge: no Refresh, never read", () => {
    const legacy = card({ pr: null });
    seed(legacy);
    const { tauri } = renderUi(<CardShipStep card={legacy} onOpenRelease={() => {}} />, { fixtures: quiet });
    expect(screen.getByText("Its pull request was opened on GitHub.")).toBeTruthy();
    expect(screen.queryByText(/was merged/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
    expect(screen.queryByText(/Checks on GitHub/)).toBeNull();
    expect(screen.queryByText(/Read from GitHub/)).toBeNull();
    expect(tauri.callsOf("card_pr_refresh")).toHaveLength(0);
  });

  it("names a merged pull request in the ship history, not a release", () => {
    const c = card({
      pr: pr({ state: "merged", checks: "passing", mergeCommit: "m1" }),
      shipStatus: "shipped",
      shipHistory: [{ commitSha: "m1", shippedVersion: "1.153.1", releaseKind: "local", shippedAt: 5 }],
    });
    renderUi(<CardShipStep card={c} onOpenRelease={() => {}} />, { fixtures: quiet });
    expect(screen.getByText("Pull request #12")).toBeTruthy();
    expect(screen.getByText("Merged on GitHub")).toBeTruthy();
    expect(screen.queryByText("v1.153.1")).toBeNull();
  });

  it("drops the closed line once the card landed another way", () => {
    const c = card({ pr: pr({ state: "closed", closedAt: 9 }), reviewStatus: "merged", shipStatus: "shipped" });
    renderUi(<CardShipStep card={c} onOpenRelease={() => {}} />, { fixtures: quiet });
    expect(screen.queryByText(/closed without merging/)).toBeNull();
  });
});
