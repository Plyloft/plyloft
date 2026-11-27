// GH #268: one meaning per "Preview". The Code header's action is the open
// Markdown file's Preview (only when there is one); the localhost preview is
// its own tool, named in the ⋯, and its pane is on the one scale.
import { describe, expect, it, vi } from "vitest";
import { CodeModeHost } from "../components/CodeModeHost";
import { BrowserPane } from "../components/BrowserPane";
import { useEditor } from "../store/editorStore";
import { useMarkdownPreview } from "../store/markdownPreviewStore";
import { useTryRuns } from "../store/tryRunStore";
import { useKanban } from "../store/kanbanStore";
import { useUi } from "../store/uiStore";
import { useWorkspaces } from "../store/workspaceStore";
import { emptyRun, tryRunKey } from "../lib/tryPanel";
import { PROJECT_TRY_ID } from "../lib/tryTile";
import type { KanbanCard } from "../ipc";
import { nextFrame, renderUi, screen, tauri, waitFor, within } from "./render";

vi.mock("../components/FilesPanel", () => ({ FilesPanel: () => <div /> }));

const WS = "ws-preview";

function quiet() {
  // The editor host asks for CODEOWNERS and other extras: not what this is about.
  tauri().allowUnhandled();
}

function headerActions(): HTMLElement {
  return document.querySelector(".ux-screen-actions") as HTMLElement;
}

describe("the Code header's Preview (GH #268)", () => {
  it("previews the open Markdown file, and is the only Preview on screen", async () => {
    quiet();
    useEditor.getState().open(WS, "/p/README.md", "# Hi\n", null);
    const r = renderUi(<CodeModeHost workspaceId={WS} cwd="/p" />);
    await nextFrame();
    expect(screen.getAllByRole("button", { name: "Preview" })).toHaveLength(1);
    const preview = within(headerActions()).getByRole("button", { name: "Preview" });
    expect(document.querySelector(".editor-statusbar")?.textContent).not.toContain("Preview");
    await r.user.click(preview);
    expect(useMarkdownPreview.getState().on[WS]?.["/p/README.md"]).toBe(true);
    expect(within(headerActions()).getByRole("button", { name: "Edit" })).toBeTruthy();
  });

  it("offers no Preview when there is nothing to preview, and names the localhost preview in the ⋯", async () => {
    quiet();
    useEditor.getState().open(WS, "/p/main.rs", "fn main() {}\n", null);
    const r = renderUi(<CodeModeHost workspaceId={WS} cwd="/p" />, {
      fixtures: { probe_localhost_ports: [] },
    });
    await nextFrame();
    expect(within(headerActions()).queryByRole("button", { name: "Preview" })).toBeNull();
    await r.user.click(screen.getByRole("button", { name: "More for Code" }));
    await r.user.click(screen.getByRole("menuitem", { name: "Show your running app" }));
    expect(document.querySelector(".browser-pane")).not.toBeNull();
    expect(screen.queryAllByRole("button", { name: "Preview" })).toHaveLength(0);
  });
});

describe("Show your running app lists the running Try sessions first (Try it TI-5)", () => {
  it("the project's, then the cards' by title, before the plain strip; one opens the strip on its address", async () => {
    quiet();
    useWorkspaces.setState({
      workspaces: [{ id: WS, name: "lyra", cwd: "/p", createdAt: 1, lastOpenedAt: 1, openFiles: [], activeFile: null }],
      activeId: WS,
    });
    const card = (id: string, title: string) => ({ id, workspaceId: WS, title, columnId: "complete", createdAt: 1, updatedAt: 1 }) as KanbanCard;
    useKanban.setState({ byWorkspace: { [WS]: { cards: [card("c1", "Dark mode"), card("c2", "Banner")], loaded: true } } });
    const running = (address: string) => ({ ...emptyRun("npm run dev"), phase: "running" as const, address });
    useTryRuns.setState({
      runs: {
        [tryRunKey(WS, "c1", null)]: running("http://localhost:41000/"),
        [tryRunKey(WS, PROJECT_TRY_ID, null)]: running("http://localhost:5173/"),
        [tryRunKey(WS, "c2", null)]: running("http://localhost:41010/"),
        [tryRunKey(WS, "c3", null)]: { ...emptyRun("npm run dev"), phase: "stopped" as const, address: "http://localhost:41020/" },
      },
    });
    useUi.getState().setCodePreviewOpen(WS, false);
    useEditor.getState().open(WS, "/p/main.rs", "fn main() {}\n", null);
    const r = renderUi(<CodeModeHost workspaceId={WS} cwd="/p" />, { fixtures: { probe_localhost_ports: [] } });
    await nextFrame();
    await r.user.click(screen.getByRole("button", { name: "More for Code" }));
    expect(screen.getAllByRole("menuitem").map((m) => m.textContent)).toEqual([
      "Go to file…⌘P",
      "New file",
      "New folder",
      "Preview lyra · localhost:5173",
      "Preview Banner · localhost:41010",
      "Preview Dark mode · localhost:41000",
      "Show your running app",
    ]);
    await r.user.click(screen.getByRole("menuitem", { name: "Preview Banner · localhost:41010" }));
    expect(useUi.getState().codePreviewTarget[WS]?.address).toBe("http://localhost:41010/");
    expect(useUi.getState().codePreviewOpen[WS]).toBe(true);
  });
});

describe("the localhost preview pane (GH #268)", () => {
  it("says what to do in words, the ports behind Details", async () => {
    renderUi(<BrowserPane workspaceId={WS} />, { fixtures: { probe_localhost_ports: [] } });
    await screen.findByText("No dev server found. Start one in a terminal, then Rescan.");
    const details = document.querySelector("details.ux-details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain("5173");
    // Outside Details, no list of ports.
    const pane = document.querySelector(".browser-pane")!.cloneNode(true) as HTMLElement;
    pane.querySelector("details")?.remove();
    expect(pane.textContent).not.toMatch(/3000|5173/);
    expect(screen.getByRole("group", { name: "What to preview" })).toBeTruthy();
    await waitFor(() => expect(document.querySelector(".browser-port-select")).toBeNull());
  });
});
