// C5: seeding one Board for the behavioural Board tests — a workspace, its
// loaded cards, and nothing else, the way the app's loaders leave them.
import type { KanbanCard } from "../ipc";
import { useKanban } from "../store/kanbanStore";
import { useWorkspaces, type Workspace } from "../store/workspaceStore";
import { tauri } from "./tauri";

export const BOARD_WS = "ws-1";

export const boardWorkspace: Workspace = {
  id: BOARD_WS,
  name: "Lyra",
  cwd: "/Users/someone/code/lyra",
  createdAt: 1,
  lastOpenedAt: 1,
  openFiles: [],
  activeFile: null,
};

let created = 0;

export function boardCard(id: string, patch: Partial<KanbanCard> = {}): KanbanCard {
  created += 1;
  return {
    id,
    workspaceId: BOARD_WS,
    title: id,
    columnId: "todo",
    createdAt: created,
    // Recent: a shipped card from these fixtures is not one the auto-archive
    // takes (UX-5.8) unless a test says so.
    updatedAt: Date.now(),
    ...patch,
  };
}

export function seedBoard(
  cards: KanbanCard[],
  workspace: Partial<Workspace> = {},
): void {
  useWorkspaces.setState({
    workspaces: [{ ...boardWorkspace, ...workspace }],
    activeId: BOARD_WS,
  });
  useKanban.setState({
    byWorkspace: { [BOARD_WS]: { cards, loaded: true } },
  });
  // The adoption banner asks once per Board; nothing to adopt here.
  tauri().fixture("workspace_adoption_status", () =>
    Promise.reject(new Error("not in these tests")),
  );
}
