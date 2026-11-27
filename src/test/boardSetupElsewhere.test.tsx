// 1.171.0 Block A walk (X2): a solo-mode folder whose shared setup was found
// on another branch still gets the board's notice — solo mode hides only the
// sharing question and the board offers.
import { describe, expect, it } from "vitest";
import { KanbanBoard } from "../components/KanbanBoard";
import { useWorkMode } from "../store/workModeStore";
import type { AdoptionStatus } from "../lib/adoption";
import { act, renderUi, screen } from "./render";
import { useUi } from "../store/uiStore";
import { seedBoard, BOARD_WS } from "./boardFixtures";

const status = (action: AdoptionStatus["action"]): AdoptionStatus => ({
  githubRepo: "o/my-notes-app",
  hasDefinition: true,
  boardRepo: "o/my-notes-app",
  action,
});

function render(action: AdoptionStatus["action"]) {
  act(() => seedBoard([]));
  act(() => useWorkMode.setState({ mode: "solo", chosen: true }));
  const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />, {
    fixtures: { workspace_adoption_status: () => status(action) },
  });
  r.tauri.allowUnhandled();
  return r;
}

describe("the shared-setup notice in solo mode (X2)", () => {
  it("shows the question about a setup on another branch", async () => {
    render({ kind: "setupElsewhere", here: "walk-ux-1171", branch: "walk-1170-rel", name: "d1170-rel" });
    expect(
      await screen.findByRole("region", { name: "This project has a shared setup on GitHub" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Keep this folder's setup" })).toBeTruthy();
  });

  it("runs no automatic step in solo mode, whatever the status says", async () => {
    const actions: AdoptionStatus["action"][] = [
      { kind: "convertLegacy" },
      { kind: "switchBoard", localCards: 2 },
      { kind: "migrateCards", localCards: 2 },
    ];
    for (const action of actions) {
      const r = render(action);
      await act(async () => {});
      await act(async () => {});
      const kind = action.kind;
      expect(r.tauri.callsOf("workspace_adoption_status")[0]?.args.solo, kind).toBe(true);
      expect(r.tauri.callsOf("workspace_definition_publish"), kind).toHaveLength(0);
      expect(r.tauri.callsOf("workspace_set_kanban_sync_mode"), kind).toHaveLength(0);
      expect(r.tauri.callsOf("kanban_github_push_local"), kind).toHaveLength(0);
      expect(r.tauri.callsOf("workspace_definition_get"), kind).toHaveLength(0);
      r.unmount();
    }
  });

  it("B1: says why a GitHub Issues board stays local, with the way to a team", async () => {
    const r = render({ kind: "soloBoardLocal" });
    expect(
      await screen.findByRole("status", { name: "This repository's board is on GitHub Issues" }),
    ).toBeTruthy();
    expect(screen.getByText("While you work alone it stays on this Mac.")).toBeTruthy();
    await r.user.click(screen.getByRole("button", { name: "Work with a team" }));
    expect(useUi.getState().settingsSection).toBe("setup");
    expect(r.tauri.callsOf("workspace_set_kanban_sync_mode")).toHaveLength(0);
    expect(r.tauri.callsOf("kanban_github_push_local")).toHaveLength(0);
  });

  it("still asks nothing about sharing in solo mode", async () => {
    const r = render({ kind: "ask" });
    await act(async () => {});
    await act(async () => {});
    expect(r.tauri.callsOf("workspace_adoption_status").length).toBeGreaterThan(0);
    expect(screen.queryByRole("region", { name: /Share this workspace's setup/ })).toBeNull();
  });
});
