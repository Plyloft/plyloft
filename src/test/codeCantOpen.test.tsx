// UX-8.5 (Code, basic): a file Code cannot open as text — binary, over 5 MB,
// not UTF-8 — opens a page in its tab instead of an error toast.
//
//  1. Opening a binary file from the tree (by keyboard) shows "Ply can't open
//     this file here", the reason in words, the path relative to the workspace
//     and Reveal in Finder, which asks the backend to reveal that path.
//  2. The header names the file: its folders in the breadcrumb, its name as
//     the title, the absolute path only in the title's tooltip.
//  3. ⌘S on that tab writes nothing; its tab closes from a real button.
//  4. A failure that is not a refusal (a missing file) is still a toast.
//  5. The CODEOWNERS ribbon is words and an icon, no emoji.
import { describe, expect, it } from "vitest";
import { CodeModeHost } from "../components/CodeModeHost";
import { useEditor } from "../store/editorStore";
import { useWorkspaces, type Workspace } from "../store/workspaceStore";
import { openInEditor } from "../lib/openInEditor";
import { act, fireEvent, nextFrame, renderUi, screen, tauri, waitFor, within } from "./render";

const CWD = "/Users/someone/code/lyra";
const LOGO = `${CWD}/assets/logo.png`;
const ws: Workspace = {
  id: "w-code",
  name: "Lyra",
  cwd: CWD,
  createdAt: 1,
  lastOpenedAt: 1,
  openFiles: [],
  activeFile: null,
};

const entry = (path: string, isDir: boolean) => ({
  name: path.split("/").pop()!,
  path,
  isDir,
  size: 0,
});

function setup(owners: string[] = []) {
  act(() => useWorkspaces.setState({ workspaces: [ws], activeId: ws.id }));
  const r = renderUi(<CodeModeHost workspaceId={ws.id} cwd={CWD} />, {
    withToasts: true,
    fixtures: {
      fs_list_dir: ({ path }: Record<string, unknown>) =>
        path === CWD ? [entry(`${CWD}/assets`, true)] : [entry(LOGO, false)],
      files_order_get: null,
      codeowners_check: { flagged: owners.length > 0, owners },
      fs_read_text_file: ({ path }: Record<string, unknown>) =>
        path === LOGO
          ? Promise.reject("binary file")
          : Promise.reject("stat: No such file or directory (os error 2)"),
      fs_reveal_in_workspace: null,
      fs_write_text_file: null,
    },
  });
  r.tauri.allowUnhandled();
  return r;
}

function openFiles() {
  return useEditor.getState().byWorkspace[ws.id]?.openFiles ?? [];
}

describe("a file Code cannot open", () => {
  it("opens a page in its tab, from the tree by keyboard, with Reveal in Finder", async () => {
    const r = setup();
    const assets = await screen.findByRole("treeitem", { name: /assets/ });
    assets.focus();
    await r.user.keyboard("{ArrowRight}");
    const logo = await screen.findByRole("treeitem", { name: /logo\.png/ });
    await r.user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(logo);
    await r.user.keyboard("{Enter}");

    const page = await screen.findByRole("region", { name: "Plyloft can't open this file here" });
    expect(within(page).getByText("It is a binary file, and the editor shows text only.")).toBeTruthy();
    expect(within(page).getByText("assets/logo.png").getAttribute("title")).toBe(LOGO);
    expect(document.querySelector(".toast")).toBeNull();

    await r.user.click(within(page).getByRole("button", { name: "Reveal in Finder" }));
    expect(tauri().callsOf("fs_reveal_in_workspace").map((c) => c.args)).toEqual([
      { workspaceId: ws.id, path: LOGO },
    ]);

    // The header: Lyra › Code › assets, and the file's name as the title.
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(crumbs.textContent).toBe("LyraCodeassets");
    const title = screen.getByRole("heading", { level: 1 });
    expect(title.textContent).toBe("logo.png");
    expect(title.querySelector("[title]")?.getAttribute("title")).toBe(LOGO);
  });

  it("writes nothing on ⌘S, and closes from a real button", async () => {
    const r = setup();
    await act(() => openInEditor(ws.id, LOGO));
    await nextFrame();
    const cm = document.querySelector<HTMLElement>(".cm-content")!;
    fireEvent.keyDown(cm, { key: "s", code: "KeyS", keyCode: 83, metaKey: true });
    await nextFrame();
    expect(tauri().callsOf("fs_write_text_file")).toEqual([]);

    const close = screen.getByRole("button", { name: "Close logo.png" });
    expect(close.tagName).toBe("BUTTON");
    await r.user.click(close);
    expect(openFiles()).toEqual([]);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Code");
  });

  it("is replaced by the text when a later open reads it", async () => {
    setup();
    await act(() => openInEditor(ws.id, LOGO));
    tauri().fixture("fs_read_text_file", "now text\n");
    await act(() => openInEditor(ws.id, LOGO));
    expect(openFiles()).toHaveLength(1);
    expect(openFiles()[0]).toMatchObject({ content: "now text\n" });
    expect(openFiles()[0].refused).toBeUndefined();
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Plyloft can't open this file here" })).toBeNull(),
    );
  });

  it("keeps a missing file a toast, with no tab", async () => {
    setup();
    await act(() => openInEditor(ws.id, `${CWD}/gone.txt`));
    expect(openFiles()).toEqual([]);
    await waitFor(() => expect(screen.getByText("File not found")).toBeTruthy());
  });
});

describe("the CODEOWNERS ribbon", () => {
  it("is words and an icon", async () => {
    setup(["@lyra/core"]);
    await act(() => openInEditor(ws.id, LOGO));
    const ribbon = await screen.findByRole("note");
    expect(ribbon.textContent).toBe(
      "Owned in CODEOWNERS: this change will need a review from @lyra/core.",
    );
    expect(ribbon.querySelector("svg")).toBeTruthy();
  });
});
