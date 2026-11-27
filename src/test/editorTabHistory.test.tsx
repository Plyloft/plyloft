// GH #170: one `EditorState` per open file, so undo survives a tab switch again
// and never crosses one. The real `EditorPanel` with a real CodeMirror view;
// tabs are opened through the editor store the way the file tree and the
// Library open them, switched by clicking the tab, and edited by typing.
//
//  1. Type in A, switch to B, back to A: ⌘Z undoes A's edit.
//  2. ⌘Z in B never produces A's bytes.
//  3. A read-only tab in between changes nothing, and ⌘S on it writes nothing.
//  4. A's selection is where it was left after a round trip through B.
//  5. A reload from disk is undoable within its own file — and only there.
//
// Every edit is **one** keystroke (review 1): CodeMirror's history groups
// keystrokes only when they arrive within 500 ms of each other, so a typed word
// could be two undo steps on a loaded machine, and one ⌘Z would not undo it.
// One character is one transaction, and so exactly one undo step.
//
// `readOnlyFile.test.ts` keeps the source contract on the buffer loads.
import { describe, expect, it } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorPanel } from "../components/EditorPanel";
import { useEditor } from "../store/editorStore";
import { useSettings } from "../store/settingsStore";
import { act, fireEvent, nextFrame, renderUi, screen, tauri, waitFor } from "./render";

const WS = "ws-history";
const A = "/Users/someone/code/project/a.txt";
const B = "/Users/someone/code/project/b.txt";
const R = "/Users/someone/Library/Application Support/com.mbadv.ply/mirror/skills/x/SKILL.md";
const A_TEXT = "alpha one\nalpha two\nalpha three\n";
const B_TEXT = "bravo\n";
const R_TEXT = "read me\n";

const fixtures = { fs_write_text_file: () => null };

function content(path: string): string | undefined {
  return useEditor.getState().byWorkspace[WS]?.openFiles.find((f) => f.path === path)?.content;
}

function view(container: HTMLElement): EditorView {
  const el = container.querySelector<HTMLElement>(".cm-editor");
  const v = el && EditorView.findFromDOM(el);
  if (!v) throw new Error("no CodeMirror view");
  return v;
}

function cm(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>(".cm-content");
  if (!el) throw new Error("no CodeMirror content element");
  return el;
}

function press(container: HTMLElement, key: string, code: string, keyCode: number) {
  fireEvent.keyDown(cm(container), { key, code, keyCode, metaKey: true });
}
const undo = (c: HTMLElement) => press(c, "z", "KeyZ", 90);
const save = (c: HTMLElement) => press(c, "s", "KeyS", 83);
const redo = (c: HTMLElement) =>
  fireEvent.keyDown(cm(c), { key: "z", code: "KeyZ", keyCode: 90, metaKey: true, shiftKey: true });

async function switchTo(user: ReturnType<typeof renderUi>["user"], name: string) {
  await user.click(screen.getByText(name, { selector: ".tab-name" }));
  await nextFrame();
}

async function typeInto(r: ReturnType<typeof renderUi>, path: string, text: string) {
  await r.user.click(cm(r.container));
  await r.user.keyboard(text);
  await waitFor(() => expect(content(path)).toContain(text));
}

/** Open the given files (the last one active), then render the panel. */
async function renderWith(files: [string, string, boolean?][], active: string) {
  for (const [path, text, readOnly] of files) {
    useEditor
      .getState()
      .open(WS, path, text, readOnly ? { place: "mirror", line: "Reading the mirror." } : null);
  }
  useEditor.getState().setActive(WS, active);
  const r = renderUi(<EditorPanel workspaceId={WS} />, { fixtures });
  await nextFrame();
  return r;
}

describe("undo across a tab switch (GH #170)", () => {
  it("1. type in A, switch to B and back: ⌘Z undoes A's edit", async () => {
    const r = await renderWith([[A, A_TEXT], [B, B_TEXT]], A);
    await typeInto(r, A, "Q");

    await switchTo(r.user, "b.txt");
    expect(cm(r.container).textContent).toContain("bravo");
    await switchTo(r.user, "a.txt");
    expect(content(A)).toContain("Q");

    undo(r.container);
    await waitFor(() => expect(content(A)).toBe(A_TEXT));
    expect(view(r.container).state.doc.toString()).toBe(A_TEXT);
    expect(content(B)).toBe(B_TEXT);
  });

  it("2. ⌘Z in B never produces A's bytes", async () => {
    const r = await renderWith([[A, A_TEXT], [B, B_TEXT]], A);
    await typeInto(r, A, "Q");

    await switchTo(r.user, "b.txt");
    for (let i = 0; i < 3; i++) undo(r.container);
    await nextFrame();
    expect(content(B)).toBe(B_TEXT);
    expect(view(r.container).state.doc.toString()).toBe(B_TEXT);
    expect(content(A)).toContain("Q");

    // …and B's own edit is B's to undo, and leaves A alone.
    await typeInto(r, B, "W");
    undo(r.container);
    await waitFor(() => expect(content(B)).toBe(B_TEXT));
    expect(content(A)).toContain("Q");
  });

  it("3. a read-only tab in between changes nothing, and ⌘S on it writes nothing", async () => {
    const r = await renderWith([[A, A_TEXT], [R, R_TEXT, true]], A);
    await typeInto(r, A, "Q");

    await switchTo(r.user, "SKILL.md");
    expect(cm(r.container).getAttribute("contenteditable")).toBe("false");
    undo(r.container);
    await r.user.click(cm(r.container));
    await r.user.keyboard("nope");
    save(r.container);
    await nextFrame();
    expect(content(R)).toBe(R_TEXT);
    expect(view(r.container).state.doc.toString()).toBe(R_TEXT);
    expect(tauri().callsOf("fs_write_text_file")).toEqual([]);
    expect(content(A)).toContain("Q");

    await switchTo(r.user, "a.txt");
    expect(cm(r.container).getAttribute("contenteditable")).toBe("true");
    undo(r.container);
    await waitFor(() => expect(content(A)).toBe(A_TEXT));
    expect(content(R)).toBe(R_TEXT);
  });

  it("4. the selection is where it was left after a round trip", async () => {
    const r = await renderWith([[A, A_TEXT], [B, B_TEXT]], A);
    // The search panel's route to a line: the selection lands on line 3.
    act(() => {
      window.dispatchEvent(
        new CustomEvent("atelier:goto-line", { detail: { workspaceId: WS, path: A, line: 3 } }),
      );
    });
    const lineThree = view(r.container).state.doc.line(3).from;
    expect(view(r.container).state.selection.main.head).toBe(lineThree);

    await switchTo(r.user, "b.txt");
    expect(view(r.container).state.selection.main.head).toBe(0);
    await switchTo(r.user, "a.txt");
    expect(view(r.container).state.doc.toString()).toBe(A_TEXT);
    expect(view(r.container).state.selection.main.head).toBe(lineThree);
  });

  it("5. a reload from disk is undoable within its own file, and only there", async () => {
    const r = await renderWith([[A, A_TEXT], [B, B_TEXT]], A);
    tauri().fixture("fs_read_text_file", ({ path }: Record<string, unknown>) =>
      path === A ? "ON DISK\n" : "B ON DISK\n",
    );
    await typeInto(r, A, "Q");
    const edited = content(A)!;

    // A is dirty, so the default strategy asks; "Reload from disk" replaces it.
    act(() => tauri().emit("fs://changed", { workspaceId: WS, path: A, kind: "modified" }));
    await r.user.click(await screen.findByRole("button", { name: "Reload from disk" }));
    await waitFor(() => expect(content(A)).toBe("ON DISK\n"));

    // B, where the reload did not happen, has nothing of it to undo.
    await switchTo(r.user, "b.txt");
    undo(r.container);
    await nextFrame();
    expect(content(B)).toBe(B_TEXT);

    // Back in A, ⌘Z is the way back to the edits the prompt said would be lost.
    await switchTo(r.user, "a.txt");
    undo(r.container);
    await waitFor(() => expect(content(A)).toBe(edited));

    // A reload of a file that is not showing lands in its stored state, and is
    // undone there too — not in the file that is showing.
    act(() => tauri().emit("fs://changed", { workspaceId: WS, path: B, kind: "modified" }));
    await waitFor(() => expect(content(B)).toBe("B ON DISK\n"));
    undo(r.container);
    await nextFrame();
    expect(content(A)).not.toContain("B ON DISK");
    await switchTo(r.user, "b.txt");
    expect(view(r.container).state.doc.toString()).toBe("B ON DISK\n");
    undo(r.container);
    await waitFor(() => expect(content(B)).toBe(B_TEXT));
  });
});

describe("state lifetime (GH #170)", () => {
  it("closing a tab drops its state: reopened, it has no history to undo or redo", async () => {
    const r = await renderWith([[A, A_TEXT], [B, B_TEXT]], A);
    await typeInto(r, A, "Q");
    // Undone, so A's bytes are the disk's again — and the edit is on A's redo
    // stack, which is exactly what a kept state would still hold.
    undo(r.container);
    await waitFor(() => expect(content(A)).toBe(A_TEXT));

    await switchTo(r.user, "b.txt");
    act(() => useEditor.getState().close(WS, A));
    await nextFrame();
    act(() => useEditor.getState().open(WS, A, A_TEXT));
    await nextFrame();
    expect(view(r.container).state.doc.toString()).toBe(A_TEXT);

    redo(r.container);
    await nextFrame();
    expect(content(A)).toBe(A_TEXT);
    undo(r.container);
    await nextFrame();
    expect(content(A)).toBe(A_TEXT);
    expect(view(r.container).state.doc.toString()).toBe(A_TEXT);
  });

  it("a theme or wrap change made while a file waited reaches it on switch-in", async () => {
    const r = await renderWith([[A, A_TEXT], [B, B_TEXT]], A);
    expect(view(r.container).state.facet(EditorView.darkTheme)).toBe(false);
    expect(cm(r.container).classList.contains("cm-lineWrapping")).toBe(false);

    await switchTo(r.user, "b.txt");
    act(() =>
      useSettings.setState((s) => ({
        settings: {
          ...s.settings,
          appearance: { ...s.settings.appearance, theme: "dark" },
          editor: { ...s.settings.editor, wordWrap: true },
        },
      })),
    );
    await nextFrame();
    // The file that is showing follows at once…
    expect(view(r.container).state.facet(EditorView.darkTheme)).toBe(true);
    expect(cm(r.container).classList.contains("cm-lineWrapping")).toBe(true);

    // …and the one that waited, when it comes back.
    await switchTo(r.user, "a.txt");
    expect(view(r.container).state.doc.toString()).toBe(A_TEXT);
    expect(view(r.container).state.facet(EditorView.darkTheme)).toBe(true);
    expect(cm(r.container).classList.contains("cm-lineWrapping")).toBe(true);
  });

  it("a reopen that loads new bytes or a new flag gets a new state", async () => {
    const mirror = { place: "mirror" as const, line: "Reading the mirror." };
    const r = await renderWith([[B, B_TEXT], [R, "first read\n", true]], R);
    expect(view(r.container).state.doc.toString()).toBe("first read\n");

    // The Library's second press: the same path, read again.
    act(() => useEditor.getState().open(WS, R, "second read\n", mirror));
    await nextFrame();
    expect(view(r.container).state.doc.toString()).toBe("second read\n");
    expect(view(r.container).state.readOnly).toBe(true);

    // The same path opened writable: editable, and nothing behind it to undo.
    act(() => useEditor.getState().open(WS, R, "second read\n"));
    await nextFrame();
    expect(cm(r.container).getAttribute("contenteditable")).toBe("true");
    expect(view(r.container).state.readOnly).toBe(false);
    undo(r.container);
    await nextFrame();
    expect(content(R)).toBe("second read\n");
  });
});
