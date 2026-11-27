// QoL 1.168 S1-1 + E5 + E4: closing a tab with unsaved changes asks
// Save and close / Don't save / Cancel (the × and ⌘W share it); Save all
// saves every unsaved file of the workspace.
import { describe, expect, it } from "vitest";
import { closeEditorTab, saveAllInWorkspace } from "../lib/editorSave";
import { useEditor } from "../store/editorStore";
import { useToasts } from "../store/toastStore";
import { act, renderUi, screen, tauri, waitFor, within } from "./render";

const fixtures = { fs_write_text_file: null };

function open(path: string, edited: boolean) {
  act(() => {
    useEditor.getState().open("w1", path, "old");
    if (edited) useEditor.getState().setContent("w1", path, "new");
  });
}

const lastToast = () => {
  const all = useToasts.getState().toasts;
  return all[all.length - 1];
};

const paths = () => (useEditor.getState().byWorkspace.w1?.openFiles ?? []).map((f) => f.path);

describe("closing an editor tab", () => {
  it("closes a saved tab at once", async () => {
    open("/r/a.md", false);
    renderUi(<div />, { fixtures });
    await act(async () => {
      expect(await closeEditorTab("w1", "/r/a.md")).toBe(true);
    });
    expect(paths()).toEqual([]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Save and close saves, then closes", async () => {
    open("/r/a.md", true);
    renderUi(<div />, { fixtures });
    let closed: Promise<boolean> = Promise.resolve(false);
    act(() => {
      closed = closeEditorTab("w1", "/r/a.md");
    });
    const sheet = await screen.findByRole("dialog", { name: "Save the changes to a.md?" });
    const save = within(sheet).getByRole("button", { name: "Save and close" });
    await waitFor(() => expect(document.activeElement).toBe(save));
    expect(within(sheet).getByRole("button", { name: "Don't save" })).toBeTruthy();
    act(() => save.click());
    expect(await closed).toBe(true);
    expect(tauri().callsOf("fs_write_text_file")[0].args).toEqual({ path: "/r/a.md", content: "new" });
    expect(paths()).toEqual([]);
  });

  it("Don't save closes without writing; Cancel keeps the tab and its edits", async () => {
    open("/r/a.md", true);
    open("/r/b.md", true);
    renderUi(<div />, { fixtures });
    let closed: Promise<boolean> = Promise.resolve(false);
    act(() => {
      closed = closeEditorTab("w1", "/r/a.md");
    });
    let sheet = await screen.findByRole("dialog");
    act(() => within(sheet).getByRole("button", { name: "Don't save" }).click());
    expect(await closed).toBe(true);
    expect(paths()).toEqual(["/r/b.md"]);

    act(() => {
      closed = closeEditorTab("w1", "/r/b.md");
    });
    sheet = await screen.findByRole("dialog");
    act(() => within(sheet).getByRole("button", { name: "Cancel" }).click());
    expect(await closed).toBe(false);
    expect(paths()).toEqual(["/r/b.md"]);
    expect(useEditor.getState().byWorkspace.w1.openFiles[0].content).toBe("new");
    expect(tauri().callsOf("fs_write_text_file")).toHaveLength(0);
  });

  it("a Save and close that can't write keeps the tab open and says so", async () => {
    open("/r/a.md", true);
    renderUi(<div />, {
      fixtures: {
        fs_write_text_file: () => {
          throw "Permission denied (os error 13)";
        },
      },
    });
    let closed: Promise<boolean> = Promise.resolve(true);
    act(() => {
      closed = closeEditorTab("w1", "/r/a.md");
    });
    const sheet = await screen.findByRole("dialog");
    act(() => within(sheet).getByRole("button", { name: "Save and close" }).click());
    expect(await closed).toBe(false);
    expect(paths()).toEqual(["/r/a.md"]);
    const toast = lastToast();
    expect(toast?.kind).toBe("error");
    expect(toast?.title).toBe("a.md could not be saved");
    expect(toast?.details).toContain("os error 13");
  });
});

describe("Save all", () => {
  it("saves every unsaved file of the workspace, and only those", async () => {
    open("/r/a.md", true);
    open("/r/b.md", false);
    open("/r/c.md", true);
    act(() => {
      useEditor.getState().open("w2", "/other/x.md", "old");
      useEditor.getState().setContent("w2", "/other/x.md", "new");
    });
    renderUi(<div />, { fixtures });
    await act(async () => {
      await saveAllInWorkspace("w1");
    });
    expect(tauri().callsOf("fs_write_text_file").map((c) => c.args.path)).toEqual(["/r/a.md", "/r/c.md"]);
    expect(lastToast()?.title).toBe("2 files saved");
    expect(useEditor.getState().byWorkspace.w2.openFiles[0].initialContent).toBe("old");
  });
});
