// CL-7: a Builder row in the sidebar says who is working, under the card's
// name — "Claude · working · 4m" while its session works, "Claude ·
// waiting for you" at its prompt — from the runtime the attached xterm
// keeps. The row is presentation only: nothing here mounts a terminal.
import { describe, expect, it } from "vitest";
import { WorkspaceSidebar } from "../components/WorkspaceSidebar";
import { useWorkspaces, type Workspace } from "../store/workspaceStore";
import { useKanban } from "../store/kanbanStore";
import { useBuilder } from "../store/builderStore";
import type { KanbanCard } from "../ipc";
import { boardCard } from "./boardFixtures";
import { act, nextFrame, renderUi, screen, tauri } from "./render";

function ws(id: string, name: string): Workspace {
  return { id, name, cwd: `/Users/someone/code/${name}`, createdAt: 1, lastOpenedAt: 1, openFiles: [], activeFile: null };
}

const started = Date.now() - 30 * 60_000;

function card(): KanbanCard {
  return {
    ...boardCard("c88", {
      title: "rollback tests",
      ghIssueNumber: 88,
      columnId: "in_progress",
      lastRunStatus: "running",
      builder: { vendor: "claude", bypass: false, ptyId: "pty-88", sessionLost: false, startedAt: started, snapshots: [] },
    }),
    workspaceId: "a",
  };
}

async function renderSidebar() {
  tauri().allowUnhandled();
  tauri().fixture("drain_status", { draining: false, startedAt: null });
  tauri().fixture("ship_pending_count", 0);
  tauri().fixture("ship_pending_cards", null);
  tauri().fixture("ship_unverified_count", 0);
  act(() => {
    useWorkspaces.setState({ workspaces: [ws("a", "alpha")], activeId: "a" });
    useKanban.setState({ byWorkspace: { a: { cards: [card()], loaded: true } } } as never);
    useBuilder.setState({
      byCard: {
        c88: { workspaceId: "a", ptyId: "pty-88", vendor: "claude", startedAt: started, lastOutputAt: Date.now(), promptBoxIdle: false, pending: [] },
      },
      submittedAt: { c88: Date.now() - 4 * 60_000 },
    });
  });
  const r = renderUi(<WorkspaceSidebar env={null} />);
  await nextFrame();
  return r;
}

describe("a Builder session row (CL-7)", () => {
  it("names the card, then who is working and what its session is doing", async () => {
    try {
      await renderSidebar();
      // The accessible name has no clock (round 2, F7); the line and the
      // tooltip do.
      const row = screen.getByRole("button", { name: "Card #88 · rollback tests, Claude · working" });
      expect(row.getAttribute("title")).toContain("Claude · working · 4m");
      expect(row.textContent).toContain("Card #88 · rollback tests");
      expect(row.textContent).toContain("Claude · working · 4m");
      expect(row.querySelector(".shell-dot--running")).toBeTruthy();

      act(() => {
        useBuilder.setState((st) => ({
          byCard: { c88: { ...st.byCard.c88!, lastOutputAt: Date.now() - 60_000, promptBoxIdle: true, turnIdle: true } },
        }));
      });
      await nextFrame();
      const idle = screen.getByRole("button", { name: "Card #88 · rollback tests, Claude · your turn" });
      expect(idle.textContent).not.toContain("building");
      expect(idle.querySelector(".shell-dot--running")).toBeNull();
    } finally {
      act(() => useBuilder.setState({ byCard: {}, sentAt: {}, submittedAt: {} }));
    }
  });
});
