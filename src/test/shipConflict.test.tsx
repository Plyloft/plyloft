// UX P1 point 7 (P-E): a local Ship stopped on a conflict, as the person
// meets it — one toast from both press sites (the card's Ship it, through
// OutcomeScreen's runner, and the review panel's Retry merge), the card page's
// Now with "Ask the Builder to resolve it" and the files in Details, the merge
// under way ("Changes sent to the Builder", Undo the merge in ⋯), and Finish
// and check's refusal while marks remain. Only Tauri is a stub.
import { describe, expect, it } from "vitest";
import { OutcomeScreen } from "../components/OutcomeScreen";
import { CardReviewPanel } from "../components/CardReviewPanel";
import { CardDetailPanel } from "../components/CardDetailPanel";
import type { KanbanCard, ReviewMergeResult, ShipOutcome } from "../ipc";
import { useToasts } from "../store/toastStore";
import { useBuilder } from "../store/builderStore";
import { useUi } from "../store/uiStore";
import { useWorkspaces } from "../store/workspaceStore";
import { cardActionError } from "../lib/cardPage";
import { BOARD_WS, boardCard, seedBoard } from "./boardFixtures";
import { act, renderUi, screen, waitFor, within } from "./render";

const builder = {
  vendor: "claude",
  bypass: false,
  ptyId: null,
  sessionLost: false,
  startedAt: 1,
  snapshots: [{ n: 1, sha: "abc1234", at: 1 }],
};

function conflicted(patch: Partial<KanbanCard> = {}): KanbanCard {
  return boardCard("c1", {
    title: "Readme card",
    notes: "Do it",
    columnId: "complete",
    lastRunStatus: "success",
    verifyStatus: "passed",
    worktreePath: "/tmp/wt/c1",
    branchName: "plyloft/card-c1",
    reviewStatus: "conflict_blocked",
    builder,
    shipConflict: { paths: ["README.md", "src/a.ts"], targetSha: "def5678", at: 2, branch: "main" },
    ...patch,
  } as Partial<KanbanCard>);
}

const OUTCOME_FIXTURES = {
  card_outcome: { filesChanged: 2, verifyConfigured: false, isRecon: false, reconVerdictNegative: false },
  improvement_proposal_state: null,
  improvement_proposal_trust_stopped: null,
  reviewer_list: [],
  verify_status: null,
  card_overlap_check: [],
  card_review_tip: null,
  ship_pending_release: { release: null, unreadable: null },
  card_review_diff: { cardId: "c1", baseBranch: "main", cardBranch: "plyloft/card-c1", files: [], generatedAt: 1 },
};

const PAGE_FIXTURES = {
  ...OUTCOME_FIXTURES,
  verify_list_inflight: [],
  worktree_env_proposal: [],
};

function workspace() {
  useWorkspaces.setState({
    workspaces: [{ id: BOARD_WS, name: "Board", cwd: "/tmp/b", createdAt: 1, lastOpenedAt: 1, openFiles: [], activeFile: null }],
    activeId: BOARD_WS,
  });
}

function lastToast() {
  const t = useToasts.getState().toasts[0];
  return t && { kind: t.kind, title: t.title, body: t.body, details: t.details, action: t.action?.label };
}

const EXPECTED_TOAST = {
  kind: "warn",
  title: "Ship stopped: main changed the same lines",
  body: "Nothing was merged, and the card's work is safe. Press Fix with the Builder, then ship again.",
  details: "README.md\nsrc/a.ts",
  action: "Ask the Builder",
};

describe("a local Ship stopped on a conflict (UX P1 point 7)", () => {
  it("both press sites raise the same toast, naming the branch, with Ask the Builder", async () => {
    workspace();
    const before = conflicted({ reviewStatus: null, shipConflict: null });
    const after = conflicted();
    act(() => seedBoard([before]));
    // The card's Ship it (OutcomeScreen's runner).
    const shipped: ShipOutcome = { kind: "local_merge", merged: false, conflictingPaths: ["README.md", "src/a.ts"], fellBack: false };
    let runner: ((mode: "merge_live" | "pr") => Promise<void>) | null = null;
    const outcome = renderUi(
      <OutcomeScreen workspaceId={BOARD_WS} card={before} onShipReady={(run) => (runner = run as typeof runner)} />,
      { withToasts: true, fixtures: { ...OUTCOME_FIXTURES, card_ship: shipped, kanban_load: [after] } },
    );
    outcome.tauri.allowUnhandled();
    await waitFor(() => expect(runner).not.toBeNull());
    await act(async () => {
      await runner!("merge_live");
    });
    await waitFor(() => expect(lastToast()?.title).toBe(EXPECTED_TOAST.title));
    const fromShip = lastToast();
    expect(fromShip).toEqual(EXPECTED_TOAST);
    // The words the toast replaced are gone.
    expect(screen.queryByText(/open developer details to resolve/)).toBeNull();
    outcome.unmount();

    // The review panel's Retry merge.
    act(() => useToasts.setState({ toasts: [] }));
    act(() => seedBoard([after]));
    const merged: ReviewMergeResult = { merged: false, conflictingPaths: ["README.md", "src/a.ts"], fastForwarded: false };
    const panel = renderUi(<CardReviewPanel workspaceId={BOARD_WS} card={after} />, {
      withToasts: true,
      fixtures: { ...OUTCOME_FIXTURES, card_review_merge: merged, kanban_load: [after] },
    });
    panel.tauri.allowUnhandled();
    await panel.user.click(screen.getByRole("button", { name: /^Retry merge/ }));
    await waitFor(() => expect(lastToast()?.title).toBe(EXPECTED_TOAST.title));
    expect(lastToast()).toEqual(fromShip);
    expect(screen.queryByText(/resolve in the worktree, then retry/)).toBeNull();
  });

  it("a card with no Builder: a plain sentence and Details, no press (adopted 15)", async () => {
    workspace();
    const alone = conflicted({ builder: null });
    act(() => seedBoard([alone]));
    useUi.setState({ selectedCardId: { [BOARD_WS]: alone.id }, centerMode: { [BOARD_WS]: "board" } });
    const page = renderUi(<CardDetailPanel workspaceId={BOARD_WS} />, {
      withToasts: true,
      fixtures: { ...PAGE_FIXTURES, kanban_load: () => [alone] },
    });
    page.tauri.allowUnhandled();
    const now = screen.getByRole("region", { name: "Now" });
    expect(
      within(now).getByText(
        "main changed the same lines as this card in 2 files. Nothing was merged. Resolve it in the card's copy, then ship again.",
      ),
    ).toBeTruthy();
    expect(within(now).getByRole("button", { name: "Ship again" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Fix with the Builder" })).toBeNull();
    // The files, in Details (the Windows walk saw the page didn't name them).
    // 1.175.0 F8: in Now's own Details.
    const details = now.querySelector("[data-ply-now-details]") as HTMLElement;
    expect(within(details).getByText("Details")).toBeTruthy();
    expect(within(details).getByText("README.md")).toBeTruthy();
    expect(within(details).getByText("src/a.ts")).toBeTruthy();
    expect(within(details).getByText("To resolve it yourself, merge main into the card's branch in its copy, then ship again.")).toBeTruthy();
  });

  it("the card page asks the Builder, then says Changes sent and offers Undo the merge in ⋯", async () => {
    workspace();
    const card = conflicted();
    act(() => seedBoard([card]));
    useUi.setState({ selectedCardId: { [BOARD_WS]: card.id }, centerMode: { [BOARD_WS]: "board" } });
    const page = renderUi(<CardDetailPanel workspaceId={BOARD_WS} />, {
      withToasts: true,
      fixtures: { ...PAGE_FIXTURES, kanban_load: () => [card] },
    });
    page.tauri.allowUnhandled();
    const now = screen.getByRole("region", { name: "Now" });
    expect(now.getAttribute("data-ply-rule")).toBe("ship-conflict");
    expect(within(now).getByText("Ship stopped on a conflict")).toBeTruthy();
    expect(within(now).getByText("main changed the same lines as this card in 2 files. Nothing was merged.")).toBeTruthy();
    const ask = within(now).getByRole("button", { name: "Fix with the Builder" });
    expect(ask.getAttribute("title")).toBe("Sends the Builder what conflicts and how to resolve it. It doesn't ship.");
    // Its other way: Ship again, for someone who resolved it by hand.
    await page.user.click(within(now).getByRole("button", { name: "Other ways: Fix with the Builder" }));
    expect(screen.getByRole("menuitem", { name: /Ship again/ })).toBeTruthy();
    await page.user.keyboard("{Escape}");

    // The merge started (what card_ship_conflict_start records).
    const resolving = conflicted({
      shipConflict: { paths: ["README.md", "src/a.ts"], targetSha: "def5678", at: 2, branch: "main", mergeStartedAt: 3 },
    });
    act(() => seedBoard([resolving]));
    await waitFor(() => expect(within(screen.getByRole("region", { name: "Now" })).getByText("Changes sent to the Builder")).toBeTruthy());
    const nowAfter = screen.getByRole("region", { name: "Now" });
    expect(nowAfter.getAttribute("data-ply-rule")).toBe("changes-sent");
    expect(within(nowAfter).getByText(/is resolving the conflict with .+\. When it's done, press Finish and check\. Ship waits until then\./)).toBeTruthy();
    expect(within(nowAfter).queryByRole("button", { name: /^Ship/ })).toBeNull();
    await page.user.click(screen.getByRole("button", { name: "More for this card" }));
    expect(screen.getByRole("menuitem", { name: /Undo the merge/ })).toBeTruthy();
  });

  it("Finish and check refused over marks says which files, with Undo the merge", () => {
    const error = cardActionError(
      "Finish and check",
      "2 files still have conflict marks: README.md, src/a.ts. Ask the Builder to finish them, or undo the merge (⋯ › Undo the merge).",
    );
    expect(error.title).toBe("Finish and check stopped: 2 files still have conflict marks.");
    expect(error.happened).toBe("Still marked: README.md, src/a.ts.");
    expect(error.untouched).toBe("Nothing was committed. The merge is still under way in the card's copy.");
    expect(error.actions.map((a) => a.label)).toEqual(["Undo the merge", "Dismiss"]);
    // One file says so.
    expect(
      cardActionError(
        "Finish and check",
        "1 file still has conflict marks: README.md. Ask the Builder to finish them, or undo the merge (⋯ › Undo the merge).",
      ).title,
    ).toBe("Finish and check stopped: 1 file still has conflict marks.");
    // (Challenger) The Builder committed the merge with its marks: no merge
    // is left to undo, so none is offered.
    const committed = cardActionError(
      "Finish and check",
      "1 file still has conflict marks: README.md. Ask the Builder to finish them.",
    );
    expect(committed.title).toBe("Finish and check stopped: 1 file still has conflict marks.");
    expect(committed.todo).toBe("Ask the Builder to finish them.");
    expect(committed.actions.map((a) => a.label)).toEqual(["Dismiss"]);
  });

  it("the store's press: the session first, then the merge, then the message; nothing pushed", async () => {
    workspace();
    const card = conflicted();
    act(() => seedBoard([card]));
    const page = renderUi(<div />, {
      withToasts: true,
      fixtures: {
        ...PAGE_FIXTURES,
        kanban_load: () => [card],
        card_ship_conflict_start: { message: "[Plyloft] Shipping this card stopped", paths: ["README.md"], branch: "main", alreadyStarted: false },
      },
    });
    page.tauri.allowUnhandled();
    // No session can be resumed here: nothing is merged or sent.
    useBuilder.setState({ resume: async () => { throw new Error("no session"); } } as never);
    const out = await act(() => useBuilder.getState().resolveShipConflict(BOARD_WS, card.id));
    expect(out).toBe("failed");
    expect(page.tauri.callsOf("card_ship_conflict_start")).toHaveLength(0);
    expect(lastToast()?.body).toBe("Its session couldn't be resumed. Nothing was merged.");
    expect(page.tauri.calls.some((c) => /push/.test(c.cmd))).toBe(false);
  });
});
