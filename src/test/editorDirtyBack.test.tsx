// Windows re-check of block 6: a tab edited back to exactly its saved text
// still said "Unsaved changes" and asked on close. Dirty is "the document
// differs from the text last loaded or saved" — on a CRLF file too.
import { describe, expect, it } from "vitest";
import { EditorPanel } from "../components/EditorPanel";
import { useEditor, isFileDirty } from "../store/editorStore";
import { act, nextFrame, renderUi, within } from "./render";

const WS = "ws-dirty-back";

async function editAndUndoByHand(path: string, text: string) {
  act(() => useEditor.getState().open(WS, path, text, null));
  const r = renderUi(<EditorPanel workspaceId={WS} />);
  r.tauri.allowUnhandled();
  await nextFrame();
  const { EditorView } = await import("@codemirror/view");
  const view = EditorView.findFromDOM(r.container.querySelector<HTMLElement>(".cm-content")!)!;
  act(() => view.dispatch({ changes: { from: 0, insert: "x" } }));
  expect(isFileDirty(useEditor.getState().byWorkspace[WS].openFiles[0])).toBe(true);
  act(() => view.dispatch({ changes: { from: 0, to: 1, insert: "" } }));
  return useEditor.getState().byWorkspace[WS].openFiles[0];
}

describe("edited back to the saved text", () => {
  it("is not dirty (LF)", async () => {
    expect(isFileDirty(await editAndUndoByHand("/p/a.ts", "a\nb\n"))).toBe(false);
  });

  it("is not dirty (CRLF), and keeps its CRLF line ends", async () => {
    const file = await editAndUndoByHand("/p/w.ts", "a\r\nb\r\n");
    expect(file.content).toBe("a\r\nb\r\n");
    expect(isFileDirty(file)).toBe(false);
  });
});

// Windows re-check of block 6: PowerShell 5.1's `>>` appended UTF-16LE — NUL
// bytes — and the tab silently kept its old text, ready for ⌘S to write over
// what was on disk.
describe("a file that stops being text on disk", () => {
  it("says so on the tab, and ⌘S asks before writing over it", async () => {
    const { screen, waitFor, fireEvent } = await import("./render");
    const path = "/p/notes.txt";
    act(() => useEditor.getState().open(WS, path, "hi\n", null));
    let disk: () => string = () => {
      throw "binary file";
    };
    const r = renderUi(<EditorPanel workspaceId={WS} />, {
      fixtures: { fs_read_text_file: () => disk(), fs_write_text_file: null },
    });
    r.tauri.allowUnhandled();
    await nextFrame();
    await waitFor(() => expect(r.tauri.listeners("fs://changed")).toBeGreaterThan(0));
    act(() => r.tauri.emit("fs://changed", { workspaceId: WS, path, kind: "modified" }));
    expect(
      await screen.findByText("notes.txt changed on disk and isn't plain text any more. Plyloft can't show it."),
    ).toBeTruthy();
    expect(useEditor.getState().byWorkspace[WS].openFiles[0].content).toBe("hi\n");

    const content = r.container.querySelector<HTMLElement>(".cm-content")!;
    fireEvent.keyDown(content, { key: "s", code: "KeyS", metaKey: true });
    const sheet = await screen.findByRole("dialog", { name: /Replace notes.txt on disk/ });
    expect(r.tauri.callsOf("fs_write_text_file")).toEqual([]);
    fireEvent.click(within(sheet).getByRole("button", { name: "Cancel" }));
    await nextFrame();
    expect(r.tauri.callsOf("fs_write_text_file")).toEqual([]);

    // Text again on disk: Reload shows it, and the notice goes.
    disk = () => "hi\nthere\n";
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(useEditor.getState().byWorkspace[WS].openFiles[0].content).toBe("hi\nthere\n"));
    expect(screen.queryByText(/isn't plain text any more/)).toBeNull();
  });
});

describe("Save all over a file that stopped being text", () => {
  it("asks first, and a No leaves the file unsaved and says why", async () => {
    const { screen, waitFor, fireEvent } = await import("./render");
    const { saveAllInWorkspace } = await import("../lib/editorSave");
    const { markNotTextOnDisk } = await import("../lib/diskNotText");
    const { useToasts } = await import("../store/toastStore");
    const path = "/p/log.txt";
    act(() => {
      useEditor.getState().open(WS, path, "a\n", null);
      useEditor.getState().setContent(WS, path, "a\nb\n");
    });
    markNotTextOnDisk(WS, path, true);
    const r = renderUi(<div />, { withToasts: true, fixtures: { fs_write_text_file: null } });
    let done = false;
    void saveAllInWorkspace(WS).then(() => (done = true));
    const sheet = await screen.findByRole("dialog", { name: /Replace log.txt on disk/ });
    fireEvent.click(within(sheet).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(done).toBe(true));
    expect(r.tauri.callsOf("fs_write_text_file")).toEqual([]);
    expect(useToasts.getState().toasts.map((t) => t.title)).toContain("log.txt could not be saved");
    markNotTextOnDisk(WS, path, false);
  });
});
