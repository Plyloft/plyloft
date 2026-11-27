// QoL 1.168 (block 10, C6): ⌘K finds the workspace's cards — by title, or by
// "#42" — under a Cards caption, and Enter opens the card.
import { describe, expect, it } from "vitest";
import { CommandPalette } from "../components/CommandPalette";
import { useWorkspaces, type Workspace } from "../store/workspaceStore";
import { useKanban } from "../store/kanbanStore";
import { useUi } from "../store/uiStore";
import { act, nextFrame, renderUi, screen, tauri, within } from "./render";

const lyra: Workspace = {
  id: "l",
  name: "Lyra",
  cwd: "/Users/someone/code/lyra",
  createdAt: 1,
  lastOpenedAt: 1,
  openFiles: [],
  activeFile: null,
};

async function renderPalette() {
  tauri().allowUnhandled();
  tauri().fixture("fs_list_files_recursive", { paths: [], truncated: false });
  act(() => {
    useWorkspaces.setState({ workspaces: [lyra], activeId: "l" });
    useKanban.setState({
      byWorkspace: {
        l: {
          loaded: true,
          cards: [
            { id: "c1", workspaceId: "l", title: "Fix the login form", columnId: "todo", createdAt: 1, ghIssueNumber: 42 },
            { id: "c2", workspaceId: "l", title: "Dark mode", columnId: "todo", createdAt: 2 },
            { id: "c3", workspaceId: "l", title: "Old login page", columnId: "todo", createdAt: 3, archived: true },
          ] as never,
        },
      },
    });
  });
  const r = renderUi(<CommandPalette activeWorkspaceId="l" claudeAvailable onOpenInstalledSelfCheck={() => {}} />);
  act(() => useUi.getState().openPalette("commands"));
  await nextFrame();
  return r;
}

const dialog = () => screen.getByRole("dialog", { name: "Search" });

describe("⌘K › Cards", () => {
  it("lists matching cards (not archived ones) and opens the one picked", async () => {
    const r = await renderPalette();
    await r.user.type(within(dialog()).getByRole("textbox", { name: "Search" }), "login");
    const list = within(dialog()).getByRole("listbox");
    expect(within(list).getByText("Cards")).toBeTruthy();
    expect(within(list).getByText("Fix the login form")).toBeTruthy();
    expect(within(list).queryByText("Old login page")).toBeNull();
    // Block 10 Mac walk: the best card match is selected, so Enter opens it.
    const selected = within(list).getAllByRole("option").find((o) => o.getAttribute("aria-selected") === "true");
    expect(selected?.textContent).toContain("Fix the login form");
    await r.user.keyboard("{Enter}");
    expect(useUi.getState().selectedCardId.l).toBe("c1");
  });

  it("offers Review a pull request…", async () => {
    const r = await renderPalette();
    await r.user.type(within(dialog()).getByRole("textbox", { name: "Search" }), "pull request");
    expect(within(within(dialog()).getByRole("listbox")).getByText("Review a pull request…")).toBeTruthy();
  });

  it("finds a card by its issue number", async () => {
    const r = await renderPalette();
    await r.user.type(within(dialog()).getByRole("textbox", { name: "Search" }), "#42");
    const list = within(dialog()).getByRole("listbox");
    expect(within(list).getByText("Fix the login form")).toBeTruthy();
  });
});
