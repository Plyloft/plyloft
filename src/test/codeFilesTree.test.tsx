// QoL 6.1–6.3 (E1, E2, E3, E7): Code's file tree keeps what the person
// opened when files come and go, lists hidden files only when Show hidden
// files is on, and has its file operations on a right-click: New file, New
// folder, Rename, Move to Trash with Undo, Copy path and Reveal. Go to file's
// index is walked again when the watcher says files came or went.
import { describe, expect, it, vi } from "vitest";
import { FilesPanel } from "../components/FilesPanel";
import { CommandPalette } from "../components/CommandPalette";
import { useSettings } from "../store/settingsStore";
import { useEditor } from "../store/editorStore";
import { useWorkspaces, type Workspace } from "../store/workspaceStore";
import { useUi } from "../store/uiStore";
import { useToasts } from "../store/toastStore";
import type { DirEntry } from "../types";
import { act, fireEvent, nextFrame, renderUi, screen, tauri, waitFor, within } from "./render";

const WS = "ws-tree";
const CWD = "/p";

const dir = (path: string): DirEntry => ({
  name: path.slice(path.lastIndexOf("/") + 1),
  path,
  isDir: true,
  size: 0,
  isSymlink: false,
});
const file = (path: string): DirEntry => ({ ...dir(path), isDir: false, size: 1 });

/** The disk the tree lists, by folder; `.`-names only with includeHidden. */
function disk(listing: Record<string, DirEntry[]>) {
  return ({ path, includeHidden }: Record<string, unknown>) =>
    (listing[String(path)] ?? []).filter((e) => includeHidden || !e.name.startsWith("."));
}

async function renderTree(listing: Record<string, DirEntry[]>, onOpen = vi.fn()) {
  const r = renderUi(<FilesPanel workspaceId={WS} cwd={CWD} onOpen={onOpen} />, {
    withToasts: true,
    fixtures: {
      fs_list_dir: disk(listing),
      files_order_get: null,
    },
  });
  await waitFor(() => expect(screen.getAllByRole("treeitem").length).toBeGreaterThan(0));
  return { ...r, onOpen };
}

const rowNames = () => screen.getAllByRole("treeitem").map((r) => r.textContent);
const row = (name: string) => screen.getAllByRole("treeitem").find((r) => r.textContent === name)!;

describe("the Code tree", () => {
  it("keeps an open folder open when a file appears beside it (E3)", async () => {
    const listing: Record<string, DirEntry[]> = {
      [CWD]: [dir("/p/src"), file("/p/README.md")],
      "/p/src": [file("/p/src/app.ts")],
    };
    const r = await renderTree(listing);
    await r.user.click(row("src"));
    await waitFor(() => expect(rowNames()).toEqual(["src", "app.ts", "README.md"]));

    listing[CWD] = [dir("/p/src"), file("/p/Login.tsx"), file("/p/README.md")];
    await waitFor(() => expect(tauri().listeners("fs://changed")).toBeGreaterThan(0));
    act(() => tauri().emit("fs://changed", { workspaceId: WS, path: "/p/Login.tsx", kind: "created" }));
    await waitFor(() => expect(rowNames()).toEqual(["src", "app.ts", "Login.tsx", "README.md"]));
    expect(row("src").getAttribute("aria-expanded")).toBe("true");

    // Plyloft's own temp file is not news: no listing for it.
    const before = tauri().callsOf("fs_list_dir").length;
    act(() =>
      tauri().emit("fs://changed", { workspaceId: WS, path: "/p/README.md.atelier-tmp", kind: "created" }),
    );
    await new Promise((res) => setTimeout(res, 200));
    expect(tauri().callsOf("fs_list_dir").length).toBe(before);
  });

  it("lists hidden files only with Show hidden files on, dimmed (E1)", async () => {
    await renderTree({ [CWD]: [dir("/p/.github"), file("/p/.env"), file("/p/a.txt")] });
    expect(rowNames()).toEqual(["a.txt"]);
    expect(tauri().callsOf("fs_list_dir")[0].args).toMatchObject({ includeHidden: false });

    act(() =>
      useSettings.setState((s) => ({
        settings: { ...s.settings, editor: { ...s.settings.editor, showHiddenFiles: true } },
      })),
    );
    await waitFor(() => expect(rowNames()).toEqual([".github", ".env", "a.txt"]));
    expect(row(".env").classList.contains("is-hidden")).toBe(true);
    expect(row("a.txt").classList.contains("is-hidden")).toBe(false);
  });

  it("offers the file operations on a right-click, and no lone sort question (E7)", async () => {
    await renderTree({ [CWD]: [dir("/p/src"), file("/p/a.txt")] });
    fireEvent.contextMenu(row("a.txt"));
    const menu = await screen.findByRole("menu", { name: "a.txt" });
    expect(within(menu).getAllByRole("menuitem").map((m) => m.textContent)).toEqual([
      "New file",
      "New folder",
      "RenameF2",
      "Move to Trash⌘⌫",
      "Copy path",
      "Copy relative path",
      "Reveal in Finder",
    ]);
  });

  it("1.176.3: a folder the computer won't let Plyloft list says folder, not file", async () => {
    const r = await renderTree({ [CWD]: [dir("/p/locked"), file("/p/a.txt")] });
    tauri().fixture("fs_list_dir", ({ path }: Record<string, unknown>) => {
      if (String(path) === "/p/locked") throw "Permission denied (os error 13)";
      return [dir("/p/locked"), file("/p/a.txt")];
    });
    await r.user.click(row("locked"));
    expect(await screen.findByText("The computer didn't let Plyloft read that folder.")).toBeTruthy();
    expect(screen.queryByText(/read or change a file/)).toBeNull();
  });

  it("1.176.3: an error nobody recognises shows no raw text, only the plain line", async () => {
    const r = await renderTree({ [CWD]: [dir("/p/locked"), file("/p/a.txt")] });
    tauri().fixture("fs_list_dir", ({ path }: Record<string, unknown>) => {
      if (String(path) === "/p/locked") throw "read_dir: Qualcosa è andato storto. (os error 9999)";
      return [dir("/p/locked"), file("/p/a.txt")];
    });
    await r.user.click(row("locked"));
    expect(await screen.findByText("Plyloft couldn't read that folder.")).toBeTruthy();
    expect(document.body.textContent).not.toContain("read_dir");
    expect(document.body.textContent).not.toContain("os error");
  });

  it("New file names the file inline, makes it and opens it", async () => {
    const listing: Record<string, DirEntry[]> = { [CWD]: [file("/p/a.txt")] };
    const r = await renderTree(listing);
    tauri().fixture("fs_create_file", ({ dir: d, name }: Record<string, unknown>) => {
      listing[CWD] = [file("/p/a.txt"), file(`/p/${String(name)}`)];
      return `${String(d)}/${String(name)}`;
    });
    fireEvent.contextMenu(row("a.txt"));
    await r.user.click(await screen.findByRole("menuitem", { name: "New file" }));
    const input = await screen.findByRole("textbox", { name: "New file name" });
    await r.user.type(input, "notes.md{Enter}");
    await waitFor(() => expect(r.onOpen).toHaveBeenCalledWith("/p/notes.md"));
    expect(tauri().callsOf("fs_create_file")[0].args).toEqual({ workspaceId: WS, dir: CWD, name: "notes.md" });
    await waitFor(() => expect(rowNames()).toEqual(["a.txt", "notes.md"]));
  });

  it("says a taken name in its own words, under the field", async () => {
    const r = await renderTree({ [CWD]: [file("/p/a.txt")] });
    tauri().fixture("fs_create_file", () => {
      throw "Something named “a.txt” is already there.";
    });
    fireEvent.contextMenu(row("a.txt"));
    await r.user.click(await screen.findByRole("menuitem", { name: "New file" }));
    await r.user.type(await screen.findByRole("textbox", { name: "New file name" }), "a.txt{Enter}");
    expect(await screen.findByText("Something named “a.txt” is already there.")).toBeTruthy();
  });

  it("Rename moves an open tab with the file", async () => {
    const listing: Record<string, DirEntry[]> = { [CWD]: [file("/p/a.txt")] };
    const r = await renderTree(listing);
    act(() => useEditor.getState().open(WS, "/p/a.txt", "hello", null));
    tauri().fixture("fs_rename_entry", () => {
      listing[CWD] = [file("/p/b.txt")];
      return "/p/b.txt";
    });
    tauri().fixture("fs_read_text_file", "hello");
    row("a.txt").focus();
    fireEvent.keyDown(row("a.txt"), { key: "F2" });
    const input = await screen.findByRole("textbox", { name: "New name for a.txt" });
    await r.user.clear(input);
    await r.user.type(input, "b.txt{Enter}");
    await waitFor(() =>
      expect(useEditor.getState().byWorkspace[WS].openFiles.map((f) => f.path)).toEqual(["/p/b.txt"]),
    );
    expect(tauri().callsOf("fs_rename_entry")[0].args).toEqual({ workspaceId: WS, path: "/p/a.txt", newName: "b.txt" });
  });

  it("refuses to rename or trash a file with unsaved changes", async () => {
    await renderTree({ [CWD]: [file("/p/a.txt")] });
    act(() => {
      useEditor.getState().open(WS, "/p/a.txt", "hello", null);
      useEditor.getState().setContent(WS, "/p/a.txt", "hello, edited");
    });
    fireEvent.contextMenu(row("a.txt"));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Move to Trash/ }));
    await waitFor(() =>
      expect(useToasts.getState().toasts.map((t) => t.title)).toContain("Save or close a.txt first"),
    );
    expect(tauri().callsOf("fs_trash_entry")).toEqual([]);
  });

  it("Move to Trash closes its tab and Undo brings both back", async () => {
    const listing: Record<string, DirEntry[]> = { [CWD]: [file("/p/a.txt"), file("/p/b.txt")] };
    await renderTree(listing);
    act(() => useEditor.getState().open(WS, "/p/a.txt", "hello", null));
    tauri().fixture("fs_trash_entry", () => {
      listing[CWD] = [file("/p/b.txt")];
      return "token-1";
    });
    tauri().fixture("fs_undo_trash", () => {
      listing[CWD] = [file("/p/a.txt"), file("/p/b.txt")];
      return "/p/a.txt";
    });
    tauri().fixture("fs_read_text_file", "hello");
    fireEvent.contextMenu(row("a.txt"));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Move to Trash/ }));
    await waitFor(() => expect(rowNames()).toEqual(["b.txt"]));
    expect(useEditor.getState().byWorkspace[WS].openFiles).toEqual([]);
    // Walk of block 6: one message — the tree's line — and no toast as well.
    expect(useToasts.getState().toasts.map((t) => t.title)).not.toContain("a.txt moved to the Trash");

    // Challenger L4: the tree keeps its own Undo line, whatever the toast does.
    const line = document.querySelector<HTMLElement>(".tree-trashed")!;
    expect(line.textContent).toContain("a.txt moved to the Trash");
    fireEvent.click(within(line).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(rowNames()).toEqual(["a.txt", "b.txt"]));
    expect(document.querySelector(".tree-trashed")).toBeNull();
    expect(tauri().callsOf("fs_undo_trash")[0].args).toEqual({ token: "token-1" });
    await waitFor(() =>
      expect(useEditor.getState().byWorkspace[WS].openFiles.map((f) => f.path)).toEqual(["/p/a.txt"]),
    );
  });
});

const lyra: Workspace = {
  id: "l",
  name: "Lyra",
  cwd: "/Users/someone/code/lyra",
  createdAt: 1,
  lastOpenedAt: 1,
  openFiles: [],
  activeFile: null,
};

describe("Go to file's index (E2)", () => {
  it("is walked again when files come or go, with hidden files as the setting says", async () => {
    tauri().allowUnhandled();
    let paths = ["src/App.tsx"];
    tauri().fixture("fs_list_files_recursive", () => ({ paths, truncated: false }));
    act(() => useWorkspaces.setState({ workspaces: [lyra], activeId: "l" }));
    renderUi(<CommandPalette activeWorkspaceId="l" claudeAvailable onOpenInstalledSelfCheck={() => {}} />);
    act(() => useUi.getState().openPalette("files"));
    await nextFrame();
    await waitFor(() => expect(screen.getByText("App.tsx")).toBeTruthy());
    expect(tauri().callsOf("fs_list_files_recursive")[0].args).toEqual({ cwd: lyra.cwd, includeHidden: false });

    // Challenger L2: a save's own temp file is not news for the index.
    act(() =>
      tauri().emit("fs://changed", { workspaceId: "l", path: `${lyra.cwd}/src/App.tsx.atelier-tmp`, kind: "created" }),
    );
    await new Promise((res) => setTimeout(res, 1000));
    expect(tauri().callsOf("fs_list_files_recursive")).toHaveLength(1);

    paths = ["src/App.tsx", "src/Login.tsx"];
    act(() => tauri().emit("fs://changed", { workspaceId: "l", path: `${lyra.cwd}/src/Login.tsx`, kind: "created" }));
    await waitFor(() => expect(screen.getByText("Login.tsx")).toBeTruthy(), { timeout: 3000 });

    act(() =>
      useSettings.setState((s) => ({
        settings: { ...s.settings, editor: { ...s.settings.editor, showHiddenFiles: true } },
      })),
    );
    await waitFor(() =>
      expect(tauri().callsOf("fs_list_files_recursive").slice(-1)[0]?.args).toEqual({ cwd: lyra.cwd, includeHidden: true }),
    );
  });
});

describe("In files from the keyboard (E9)", () => {
  it("↓ and Enter open the match pointed at, with its text selected", async () => {
    tauri().allowUnhandled();
    tauri().fixture("ripgrep_available", true);
    tauri().fixture("search_start", null);
    tauri().fixture("search_cancel", null);
    tauri().fixture("fs_read_text_file", "x");
    act(() => useWorkspaces.setState({ workspaces: [lyra], activeId: "l" }));
    const r = renderUi(
      <CommandPalette activeWorkspaceId="l" claudeAvailable onOpenInstalledSelfCheck={() => {}} />,
    );
    act(() => useUi.getState().openPalette("text"));
    await nextFrame();
    const field = screen.getByRole("textbox", { name: "Search" });
    await r.user.type(field, "login");
    await waitFor(() => expect(tauri().callsOf("search_start").length).toBeGreaterThan(0));
    const match = (path: string, lineNumber: number, lineText: string, start: number) => ({
      workspaceId: "l",
      path,
      lineNumber,
      lineText,
      matchText: "login",
      columnStart: start,
      columnEnd: start + 5,
    });
    act(() => {
      tauri().emit("search://result", match(`${lyra.cwd}/a.ts`, 3, "const login = 1;", 6));
      tauri().emit("search://result", match(`${lyra.cwd}/b.ts`, 9, "é login()", 3));
    });
    await waitFor(() => expect(screen.getAllByRole("button", { name: /login/ }).length).toBe(2));
    const gotos: unknown[] = [];
    const onGoto = (e: Event) => gotos.push((e as CustomEvent).detail);
    window.addEventListener("atelier:goto-line", onGoto);
    // Challenger D3: Enter on an option button is that button's, not a match's.
    const option = screen.getByRole("button", { name: "Match case" });
    option.focus();
    fireEvent.keyDown(option, { key: "Enter" });
    fireEvent.keyDown(option, { key: "ArrowDown" });
    await nextFrame();
    expect(gotos).toEqual([]);
    expect(document.querySelector(".palette-item.active")?.textContent).toContain("const login");
    field.focus();
    fireEvent.keyDown(field, { key: "ArrowDown" });
    await waitFor(() =>
      expect(document.querySelector(".palette-item.active")?.textContent).toContain("é login()"),
    );
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(gotos).toHaveLength(1));
    window.removeEventListener("atelier:goto-line", onGoto);
    // "é" is two bytes: the match is at UTF-16 column 2, not byte 3.
    expect(gotos[0]).toEqual({
      workspaceId: "l",
      path: `${lyra.cwd}/b.ts`,
      line: 9,
      from: 2,
      to: 7,
      // Walk of block 6: ⌘G there follows the search's options (Match case off).
      find: { search: "login", caseSensitive: false, regexp: false, wholeWord: false },
    });
    expect(useUi.getState().centerMode.l).toBe("code");
  });
});

describe("⌘K Open file (E8)", () => {
  it("goes to the file in Code, from the Board too", async () => {
    tauri().allowUnhandled();
    tauri().fixture("fs_list_files_recursive", { paths: [], truncated: false });
    act(() => {
      useWorkspaces.setState({ workspaces: [lyra], activeId: "l" });
      useEditor.getState().open("l", `${lyra.cwd}/src/App.tsx`, "x", null);
      useEditor.getState().open("l", `${lyra.cwd}/README.md`, "y", null);
      useUi.getState().setCenterMode("l", "board");
    });
    const r = renderUi(
      <CommandPalette activeWorkspaceId="l" claudeAvailable onOpenInstalledSelfCheck={() => {}} />,
    );
    act(() => useUi.getState().openPalette("commands"));
    await nextFrame();
    await r.user.click(screen.getByText("Open file: App.tsx"));
    await waitFor(() => expect(useUi.getState().centerMode.l).toBe("code"));
    expect(useEditor.getState().byWorkspace.l.activePath).toBe(`${lyra.cwd}/src/App.tsx`);
  });
});

// Challenger D2: reads are async and can finish out of order; the newest wins.
describe("reads that finish out of order", () => {
  it("a clean tab ends on the newest bytes from disk, not an older read", async () => {
    const { EditorPanel } = await import("../components/EditorPanel");
    const path = "/p/App.tsx";
    act(() => useEditor.getState().open(WS, path, "v0", null));
    const pending: ((v: string) => void)[] = [];
    const { tauri: t } = renderUi(<EditorPanel workspaceId={WS} />, {
      fixtures: { fs_read_text_file: () => new Promise<string>((res) => pending.push(res)) },
    });
    t.allowUnhandled();
    await nextFrame();
    await waitFor(() => expect(t.listeners("fs://changed")).toBeGreaterThan(0));
    act(() => t.emit("fs://changed", { workspaceId: WS, path, kind: "modified" }));
    act(() => t.emit("fs://changed", { workspaceId: WS, path, kind: "modified" }));
    await waitFor(() => expect(pending).toHaveLength(2));
    await act(async () => pending[1]("v2"));
    await waitFor(() => expect(useEditor.getState().byWorkspace[WS].openFiles[0].content).toBe("v2"));
    await act(async () => pending[0]("v1"));
    await nextFrame();
    expect(useEditor.getState().byWorkspace[WS].openFiles[0].content).toBe("v2");
  });

  it("a folder's older listing that finishes last is dropped", async () => {
    const answers: ((v: DirEntry[]) => void)[] = [];
    let first = true;
    renderUi(<FilesPanel workspaceId={WS} cwd={CWD} onOpen={vi.fn()} />, {
      fixtures: {
        fs_list_dir: () => {
          if (first) {
            first = false;
            return [file("/p/a.txt")];
          }
          return new Promise<DirEntry[]>((res) => answers.push(res));
        },
        files_order_get: null,
      },
    });
    await waitFor(() => expect(rowNames()).toEqual(["a.txt"]));
    await waitFor(() => expect(tauri().listeners("fs://changed")).toBeGreaterThan(0));
    act(() => tauri().emit("fs://changed", { workspaceId: WS, path: "/p/b.txt", kind: "created" }));
    await waitFor(() => expect(answers).toHaveLength(1));
    act(() => tauri().emit("fs://changed", { workspaceId: WS, path: "/p/c.txt", kind: "created" }));
    await waitFor(() => expect(answers).toHaveLength(2));
    await act(async () => answers[1]([file("/p/a.txt"), file("/p/b.txt"), file("/p/c.txt")]));
    await waitFor(() => expect(rowNames()).toEqual(["a.txt", "b.txt", "c.txt"]));
    await act(async () => answers[0]([file("/p/a.txt"), file("/p/b.txt")]));
    await nextFrame();
    expect(rowNames()).toEqual(["a.txt", "b.txt", "c.txt"]);
  });
});

describe("the tree from the keyboard, and its smaller manners (Reviewer L1, L3, L4)", () => {
  it("⌘⌫ on a row moves it to the Trash; the menu key and the row's ⋯ open its menu", async () => {
    const listing: Record<string, DirEntry[]> = { [CWD]: [file("/p/a.txt")] };
    await renderTree(listing);
    tauri().fixture("fs_trash_entry", () => {
      listing[CWD] = [];
      return "t";
    });
    fireEvent.keyDown(row("a.txt"), { key: "ContextMenu" });
    expect(await screen.findByRole("menu", { name: "a.txt" })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("menu", { name: "a.txt" }), { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "More for a.txt" }));
    expect(await screen.findByRole("menu", { name: "a.txt" })).toBeTruthy();
    fireEvent.keyDown(row("a.txt"), { key: "Backspace", metaKey: true });
    await waitFor(() => expect(tauri().callsOf("fs_trash_entry")).toHaveLength(1));
  });

  it("leaving the name field keeps a typed name; an empty one is dropped", async () => {
    const r = await renderTree({ [CWD]: [file("/p/a.txt")] });
    tauri().fixture("fs_create_dir", ({ name }: Record<string, unknown>) => `/p/${String(name)}`);
    fireEvent.contextMenu(row("a.txt"));
    await r.user.click(await screen.findByRole("menuitem", { name: "New folder" }));
    const input = await screen.findByRole("textbox", { name: "New folder name" });
    await r.user.type(input, "docs");
    fireEvent.blur(input);
    await waitFor(() => expect(tauri().callsOf("fs_create_dir")).toHaveLength(1));

    fireEvent.contextMenu(row("a.txt"));
    await r.user.click(await screen.findByRole("menuitem", { name: "New folder" }));
    fireEvent.blur(await screen.findByRole("textbox", { name: "New folder name" }));
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
    expect(tauri().callsOf("fs_create_dir")).toHaveLength(1);
  });

  it("a rename closes the tab before the file moves, so no removed warning reaches it", async () => {
    const listing: Record<string, DirEntry[]> = { [CWD]: [file("/p/a.txt")] };
    const r = await renderTree(listing);
    act(() => useEditor.getState().open(WS, "/p/a.txt", "hello", null));
    tauri().fixture("fs_rename_entry", () => {
      // The tab is already closed when the file is renamed.
      expect(useEditor.getState().byWorkspace[WS].openFiles).toEqual([]);
      listing[CWD] = [file("/p/b.txt")];
      return "/p/b.txt";
    });
    tauri().fixture("fs_read_text_file", "hello");
    fireEvent.keyDown(row("a.txt"), { key: "F2" });
    const input = await screen.findByRole("textbox", { name: "New name for a.txt" });
    await r.user.clear(input);
    await r.user.type(input, "b.txt{Enter}");
    await waitFor(() =>
      expect(useEditor.getState().byWorkspace[WS].openFiles.map((f) => f.path)).toEqual(["/p/b.txt"]),
    );
  });

  it("Copy path says it copied", async () => {
    await renderTree({ [CWD]: [file("/p/a.txt")] });
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    fireEvent.contextMenu(row("a.txt"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Copy relative path" }));
    await waitFor(() => expect(useToasts.getState().toasts.map((t) => t.title)).toContain("Relative path copied"));
    expect(writeText).toHaveBeenCalledWith("a.txt");
  });
});

// Windows walk of block 6: the Recycle Bin took seconds to answer.
describe("a move to the bin that takes a while", () => {
  it("shows at once, offers Undo when the bin answers, and comes back if refused", async () => {
    const listing: Record<string, DirEntry[]> = { [CWD]: [file("/p/a.txt"), file("/p/b.txt")] };
    await renderTree(listing);
    let answer: (v: unknown) => void = () => {};
    let refuse: (e: unknown) => void = () => {};
    tauri().fixture("fs_trash_entry", () => new Promise((res, rej) => ((answer = res), (refuse = rej))));
    fireEvent.keyDown(row("a.txt"), { key: "Backspace", metaKey: true });
    await waitFor(() => expect(rowNames()).toEqual(["b.txt"]));
    const line = document.querySelector<HTMLElement>(".tree-trashed")!;
    expect(line.textContent).toContain("a.txt moved to the Trash");
    expect(within(line).getByRole<HTMLButtonElement>("button", { name: "Undo" }).disabled).toBe(true);
    listing[CWD] = [file("/p/b.txt")];
    await act(async () => answer("t-1"));
    await waitFor(() =>
      expect(within(line).getByRole<HTMLButtonElement>("button", { name: "Undo" }).disabled).toBe(false),
    );

    // A refusal puts the row back and says why.
    fireEvent.keyDown(row("b.txt"), { key: "Backspace", metaKey: true });
    await waitFor(() => expect(screen.queryAllByRole("treeitem")).toHaveLength(0));
    await act(async () => refuse("the disk is read-only"));
    await waitFor(() => expect(rowNames()).toEqual(["b.txt"]));
    expect(document.querySelector(".tree-trashed")).toBeNull();
    expect(useToasts.getState().toasts.map((t) => t.title)).toContain("b.txt wasn't moved to the Trash");
  });
});

describe("In files results order (walk of block 6)", () => {
  it("is the same however the matches arrived: files by path, matches by line", async () => {
    const { filesOf } = await import("../components/SearchPanel");
    const m = (path: string, lineNumber: number, columnStart = 0) => ({
      workspaceId: "l",
      path,
      lineNumber,
      lineText: "",
      matchText: "",
      columnStart,
      columnEnd: columnStart + 1,
    });
    const one = [m("/p/b.ts", 9), m("/p/a.ts", 3), m("/p/b.ts", 2), m("/p/a.ts", 3, 0)];
    const two = [m("/p/a.ts", 3, 0), m("/p/b.ts", 2), m("/p/a.ts", 3), m("/p/b.ts", 9)];
    const shape = (r: typeof one) =>
      [...filesOf(r).entries()].map(([p, ms]) => [p, ms.map((x) => `${x.lineNumber}:${x.columnStart}`)]);
    expect(shape(one)).toEqual(shape(two));
    expect(shape(one)).toEqual([
      ["/p/a.ts", ["3:0", "3:0"]],
      ["/p/b.ts", ["2:0", "9:0"]],
    ]);
  });
});
