// 1.173.0 (C3, mockup two-macs.html scene 2): a shared setting both sides
// changed asks before anything overwrites it — only the difference, focus on
// keeping theirs, the answer sent to the backend; closing it decides nothing.
import { afterEach, describe, expect, it } from "vitest";
import { SettingConflictHost } from "../components/SettingConflictHost";
import { onRefreshForConflicts, useSettingConflict } from "../store/settingConflictStore";
import { useWorkspaces } from "../store/workspaceStore";
import type { DefinitionRefreshReport, SettingConflict } from "../ipc";
import { act, renderUi, screen, waitFor, within } from "./render";

const conflict: SettingConflict = {
  field: "versionFiles",
  label: "Version files",
  author: "test-owner",
  device: "MacBook Pro",
  samePerson: true,
  changedAt: Math.floor(Date.now() / 1000) - 600,
  theirs: [{ path: "frontend/package.json" }],
  difference: {
    list: true,
    both: ["frontend/package.json", "main.py", "config/appConfig.py"],
    onlyMine: ["shopify/package.json"],
    onlyTheirs: [],
    different: [],
    theirs: "",
    mine: "",
  },
};

function report(workspaceId: string): DefinitionRefreshReport {
  return {
    workspaceId,
    moment: "periodic",
    hasDefinition: true,
    source: "repo",
    branch: "main",
    author: null,
    commit: null,
    changes: [],
    unreadable: null,
    fetchError: null,
    pendingFields: ["versionFiles"],
    pendingState: "pendingSync",
    publish: {
      branch: "main",
      published: [],
      commit: null,
      overrides: [],
      pullRequest: null,
      pullRequestFields: [],
      closedPullRequests: [],
      withdrawnPullRequests: [],
      error: null,
      offline: false,
      conflicts: ["versionFiles"],
    },
  };
}

afterEach(() => {
  useSettingConflict.setState({ open: null, busy: false, error: null, asked: new Set() });
});

describe("a shared setting both sides changed", () => {
  it("shows only the difference, starts on keeping theirs and sends the answer", async () => {
    const { user, tauri } = renderUi(<SettingConflictHost />, {
      fixtures: {
        workspace_definition_get: { conflicts: [conflict] },
        workspace_definition_resolve_conflict: true,
      },
    });
    await act(async () => {
      await useSettingConflict.getState().show("ws-1", "versionFiles");
    });
    const sheet = await screen.findByRole("dialog", {
      name: "Your MacBook Pro changed “Version files” 10 min ago",
    });
    expect(sheet.textContent).toContain("You changed it here too, before seeing that. Which should the repository keep?");
    expect(sheet.textContent).toContain("Both have");
    expect(sheet.textContent).toContain("Only this Mac adds");
    expect(sheet.textContent).toContain("+ shopify/package.json");
    const keep = within(sheet).getByRole("button", { name: "Keep the MacBook Pro’s" });
    await waitFor(() => expect(document.activeElement).toBe(keep));

    tauri.fixture("workspace_definition_get", { conflicts: [] });
    await user.click(within(sheet).getByRole("button", { name: "Use this Mac’s" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(tauri.callsOf("workspace_definition_resolve_conflict").map((c) => c.args)).toEqual([
      {
        workspaceId: "ws-1",
        field: "versionFiles",
        choice: "mine",
        shown: { theirs: conflict.theirs, changedAt: conflict.changedAt },
      },
    ]);
  });

  it("closing it decides nothing", async () => {
    const { user, tauri } = renderUi(<SettingConflictHost />, {
      fixtures: { workspace_definition_get: { conflicts: [conflict] } },
    });
    await act(async () => {
      await useSettingConflict.getState().show("ws-1");
    });
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(tauri.callsOf("workspace_definition_resolve_conflict")).toEqual([]);
  });

  it("opens by itself only on the workspace the person is on, once", async () => {
    renderUi(<SettingConflictHost />, {
      fixtures: { workspace_definition_get: { conflicts: [conflict] } },
    });
    const focus = document.hasFocus;
    document.hasFocus = () => true;
    try {
      act(() => useWorkspaces.setState({ activeId: "ws-2" }));
      await act(async () => {
        onRefreshForConflicts(report("ws-1"));
        await new Promise((r) => setTimeout(r, 0));
      });
      expect(screen.queryByRole("dialog")).toBeNull();

      act(() => useWorkspaces.setState({ activeId: "ws-1" }));
      await act(async () => {
        onRefreshForConflicts(report("ws-1"));
        await new Promise((r) => setTimeout(r, 0));
      });
      await screen.findByRole("dialog");
      act(() => useSettingConflict.getState().close());
      await act(async () => {
        onRefreshForConflicts(report("ws-1"));
        await new Promise((r) => setTimeout(r, 0));
      });
      expect(screen.queryByRole("dialog")).toBeNull();
    } finally {
      document.hasFocus = focus;
    }
  });

  it("an answer to a question the other side changed since shows the new one", async () => {
    const newer: SettingConflict = {
      ...conflict,
      changedAt: conflict.changedAt! + 60,
      theirs: [{ path: "web/package.json" }],
      difference: { ...conflict.difference, both: [], onlyMine: ["shopify/package.json"], onlyTheirs: ["web/package.json"] },
    };
    const { user, tauri } = renderUi(<SettingConflictHost />, {
      fixtures: {
        workspace_definition_get: { conflicts: [conflict] },
        workspace_definition_resolve_conflict: false,
      },
    });
    await act(async () => {
      await useSettingConflict.getState().show("ws-1");
    });
    const sheet = await screen.findByRole("dialog");
    tauri.fixture("workspace_definition_get", { conflicts: [newer] });
    await user.click(within(sheet).getByRole("button", { name: "Use this Mac’s" }));
    const again = await screen.findByRole("dialog", { name: "Your MacBook Pro changed “Version files” 9 min ago" });
    expect(again.textContent).toContain("Only the MacBook Pro has");
    expect(again.textContent).toContain("web/package.json");
  });

  it("keeping theirs says what was dropped", async () => {
    const { user } = renderUi(<SettingConflictHost />, {
      withToasts: true,
      fixtures: {
        workspace_definition_get: { conflicts: [conflict] },
        workspace_definition_resolve_conflict: true,
      },
    });
    await act(async () => {
      await useSettingConflict.getState().show("ws-1");
    });
    const sheet = await screen.findByRole("dialog");
    await user.click(within(sheet).getByRole("button", { name: "Keep the MacBook Pro’s" }));
    expect(await screen.findByText("Your change to “Version files” was dropped")).toBeTruthy();
    expect(screen.getByText("+ shopify/package.json")).toBeTruthy();
  });
});
