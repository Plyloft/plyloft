// 1.171.0 D3 (FR-5): a card's copy started from the last saved version; the
// card says so while the project folder has changes not saved in Git.
import { describe, expect, it, vi } from "vitest";
import { CardDetailPanel } from "../components/CardDetailPanel";
import type { KanbanCard } from "../ipc";
import { useBuilder } from "../store/builderStore";
import { useUi } from "../store/uiStore";
import { BOARD_WS, boardCard, seedBoard } from "./boardFixtures";
import { renderUi, screen, waitFor } from "./render";

vi.mock("../components/BuilderSession", () => ({
  BuilderSession: ({ cardId }: { cardId: string }) => <div data-testid={`terminal-${cardId}`} />,
}));
vi.mock("../components/OutcomeScreen", () => ({
  OutcomeScreen: () => <div data-testid="outcome" />,
}));

const LINE =
  "Started from the last saved version of your project. Your project folder, on main, has changes in 12 files or folders that aren't saved in Git, so this card doesn't have them.";

function building(over: Partial<KanbanCard> = {}): KanbanCard {
  return boardCard("c1", {
    title: "Add a nod function",
    notes: "Add nod() to greet.js",
    columnId: "in_progress",
    lastRunStatus: "running",
    worktreePath: "/tmp/wt/c1",
    worktreeBase: { commit: "abc", refName: "origin/main", source: "origin", note: null },
    branchName: "atelier/card-c1",
    builder: { vendor: "claude", bypass: false, ptyId: "pty-1", sessionLost: false, startedAt: Date.now() - 60_000, snapshots: [] },
    ...over,
  } as Partial<KanbanCard>);
}

function openCard(card: KanbanCard, unsaved: number, branch = "main") {
  seedBoard([card]);
  useUi.setState({ selectedCardId: { [BOARD_WS]: card.id }, centerMode: { [BOARD_WS]: "board" } });
  useBuilder.setState({ byCard: {}, vendorPref: {}, trustAsking: {} });
  const view = renderUi(<CardDetailPanel workspaceId={BOARD_WS} />, {
    fixtures: {
      project_unsaved_files: { files: unsaved, branch },
      card_overlap_check: [],
      reviewer_list: [],
      verify_status: null,
      verify_list_inflight: [],
      improvement_proposal_state: null,
      improvement_proposal_trust_stopped: null,
      ship_pending_release: { release: null, unreadable: null },
      card_review_tip: null,
      worktree_env_proposal: [],
      kanban_load: () => [card],
    },
  });
  view.tauri.allowUnhandled();
  return view;
}

describe("a card whose project folder has changes not saved in Git", () => {
  it("says its copy started from the last saved version, read from the project folder", async () => {
    const view = openCard(building(), 12);
    await waitFor(() => expect(screen.getByText(LINE)).toBeTruthy());
    const asked = view.tauri.callsOf("project_unsaved_files");
    expect(asked.length).toBeGreaterThan(0);
    expect(typeof asked[0].args.path).toBe("string");
    // Read-only: nothing is saved for the person.
    expect(view.tauri.callsOf("project_save_work")).toHaveLength(0);
  });

  it("says nothing when the folder has nothing unsaved, or the card hasn't started", async () => {
    const view = openCard(building(), 0);
    await waitFor(() => expect(view.tauri.callsOf("project_unsaved_files").length).toBeGreaterThan(0));
    expect(screen.queryByText(/aren't saved in Git/)).toBeNull();
    view.unmount();
    const before = view.tauri.callsOf("project_unsaved_files").length;
    const fresh = openCard(building({ worktreePath: null, columnId: "todo", lastRunStatus: null, builder: null } as Partial<KanbanCard>), 12);
    await new Promise((r) => setTimeout(r, 20));
    expect(fresh.tauri.callsOf("project_unsaved_files")).toHaveLength(before);
    expect(screen.queryByText(/aren't saved in Git/)).toBeNull();
    fresh.unmount();
    // The folder is on another branch than the card's: not this card's.
    const other = openCard(building(), 12, "my-work");
    await waitFor(() => expect(other.tauri.callsOf("project_unsaved_files").length).toBeGreaterThan(before));
    expect(screen.queryByText(/aren't saved in Git/)).toBeNull();
  });
});
