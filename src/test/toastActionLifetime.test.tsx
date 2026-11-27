// Challenger, 2026-10-19: an action toast now stays until it is dismissed. One
// whose action belongs to a screen — *Already up to date*'s Delete card opens
// OutcomeScreen's own dialog — goes when the screen does, instead of staying on
// with a press that would do nothing.
import { describe, expect, it } from "vitest";
import { OutcomeScreen } from "../components/OutcomeScreen";
import type { KanbanCard, ShipOutcome } from "../ipc";
import { useToasts } from "../store/toastStore";
import { useWorkspaces } from "../store/workspaceStore";
import { BOARD_WS, boardCard, seedBoard } from "./boardFixtures";
import { act, renderUi, waitFor } from "./render";

const FIXTURES = {
  card_outcome: { filesChanged: 1, verifyConfigured: false, isRecon: false, reconVerdictNegative: false },
  improvement_proposal_state: null,
  improvement_proposal_trust_stopped: null,
  reviewer_list: [],
  verify_status: null,
  card_overlap_check: [],
  card_review_tip: null,
  ship_pending_release: { release: null, unreadable: null },
  card_review_diff: { cardId: "c1", baseBranch: "main", cardBranch: "plyloft/card-c1", files: [], generatedAt: 1 },
};

describe("an action toast that belongs to a screen", () => {
  it("Already up to date's Delete card goes with OutcomeScreen", async () => {
    useWorkspaces.setState({
      workspaces: [{ id: BOARD_WS, name: "Board", cwd: "/tmp/b", createdAt: 1, lastOpenedAt: 1, openFiles: [], activeFile: null }],
      activeId: BOARD_WS,
    });
    const card = boardCard("c1", {
      title: "Skill card",
      columnId: "complete",
      lastRunStatus: "success",
      verifyStatus: "passed",
      worktreePath: "/tmp/wt/c1",
      branchName: "plyloft/card-c1",
    } as Partial<KanbanCard>);
    act(() => seedBoard([card]));
    const shipped = { kind: "skill_up_to_date", merged: false, skillNote: "The team library has this already." } as unknown as ShipOutcome;
    let runner: ((mode: "merge_live" | "pr") => Promise<void>) | null = null;
    const screen = renderUi(
      <OutcomeScreen workspaceId={BOARD_WS} card={card} onShipReady={(run) => (runner = run as typeof runner)} />,
      { withToasts: true, fixtures: { ...FIXTURES, card_ship: shipped, kanban_load: [card] } },
    );
    screen.tauri.allowUnhandled();
    await waitFor(() => expect(runner).not.toBeNull());
    await act(async () => {
      await runner!("merge_live");
    });
    const titles = () => useToasts.getState().toasts.map((t) => [t.title, t.action?.label]);
    await waitFor(() => expect(titles()).toEqual([["Already up to date", "Delete card"]]));
    screen.unmount();
    expect(titles()).toEqual([]);
  });
});
