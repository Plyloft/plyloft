// UX-3.5: every mode opens with the same screen header — Workspace › Mode,
// the title, the mode's actions — and the sidebar button beside it.
import { describe, expect, it } from "vitest";
import { ModeHeader } from "../components/ModeHeader";
import { useWorkspaces, type Workspace } from "../store/workspaceStore";
import { DEFAULT_SETTINGS, useSettings, type Settings } from "../store/settingsStore";
import { act, renderUi, screen, tauri, within } from "./render";

const lyra: Workspace = {
  id: "l",
  name: "Lyra",
  cwd: "/Users/someone/code/lyra",
  createdAt: 1,
  lastOpenedAt: 1,
  openFiles: [],
  activeFile: null,
};

describe("the mode header", () => {
  it("names the workspace and the mode, and holds the actions", () => {
    act(() => useWorkspaces.setState({ workspaces: [lyra], activeId: "l" }));
    renderUi(<ModeHeader mode="board" actions={<button type="button">New card</button>} />);
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(crumbs.textContent).toBe("LyraBoard");
    expect(within(crumbs).getByText("Board").getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Board");
    expect(screen.getByRole("button", { name: "New card" })).toBeTruthy();
  });

  it("scopes the global modes to all workspaces and calls Activity History", () => {
    act(() => useWorkspaces.setState({ workspaces: [lyra], activeId: "l" }));
    renderUi(<ModeHeader mode="activity" />);
    expect(screen.getByRole("navigation", { name: "Breadcrumb" }).textContent).toBe(
      "All workspacesHistory",
    );
  });

  it("hides the sidebar from its button, remembered like ⌘\\", async () => {
    tauri().fixture("settings_set", ({ settings }: Record<string, unknown>) => settings);
    act(() => useSettings.setState({ settings: DEFAULT_SETTINGS, loaded: true }));
    const r = renderUi(<ModeHeader mode="code" />);
    await r.user.click(screen.getByRole("button", { name: "Toggle sidebar" }));
    const [call] = tauri().callsOf("settings_set");
    expect((call.args.settings as Settings).windows.sidebar).toEqual({ width: 240, collapsed: true });
  });
});
