// QoL walk of block 6 (real WebKit, Italian keyboard): ⌘/ there is ⌘⇧7,
// reported as key "7" with code Digit7, which CodeMirror's Mod-/ never
// matches. The editor answers it itself; a US ⌘/ stays CodeMirror's own.
import { describe, expect, it } from "vitest";
import { EditorPanel } from "../components/EditorPanel";
import { useEditor } from "../store/editorStore";
import { setPlatformForTests } from "../lib/platform";
import { act, fireEvent, nextFrame, renderUi, waitFor } from "./render";

const WS = "ws-comment";
const PATH = "/p/app.ts";

async function renderTs() {
  setPlatformForTests("mac");
  act(() => useEditor.getState().open(WS, PATH, "const a = 1;\n", null));
  const r = renderUi(<EditorPanel workspaceId={WS} />);
  r.tauri.allowUnhandled();
  await nextFrame();
  const content = r.container.querySelector<HTMLElement>(".cm-content");
  if (!content) throw new Error("no editor");
  return content;
}

const text = () => useEditor.getState().byWorkspace[WS].openFiles[0].content;

describe("Toggle comment", () => {
  it("answers the Italian ⌘⇧7 reported as key 7", async () => {
    const content = await renderTs();
    fireEvent.keyDown(content, { key: "7", code: "Digit7", metaKey: true, shiftKey: true });
    await waitFor(() => expect(text()).toBe("// const a = 1;\n"));
    setPlatformForTests(null);
  });

  it("answers the US ⌘/ through CodeMirror's own binding", async () => {
    const content = await renderTs();
    fireEvent.keyDown(content, { key: "/", code: "Slash", metaKey: true });
    await waitFor(() => expect(text()).toBe("// const a = 1;\n"));
    setPlatformForTests(null);
  });

  it("leaves ⌘7 (a workspace) alone", async () => {
    const content = await renderTs();
    fireEvent.keyDown(content, { key: "7", code: "Digit7", metaKey: true });
    await nextFrame();
    expect(text()).toBe("const a = 1;\n");
    setPlatformForTests(null);
  });
});

// Walk of block 6: ⌘G after an In files match follows the search's options —
// with Match case off it steps from "notes" to "Notes".
describe("⌘G after an In files match", () => {
  it("follows Match case off", async () => {
    const { EditorView } = await import("@codemirror/view");
    setPlatformForTests("mac");
    act(() => useEditor.getState().open(WS, "/p/README.md", "notes\nNotes\n", null));
    const r = renderUi(<EditorPanel workspaceId={WS} />);
    r.tauri.allowUnhandled();
    await nextFrame();
    const content = r.container.querySelector<HTMLElement>(".cm-content")!;
    const view = EditorView.findFromDOM(content)!;
    act(() => {
      window.dispatchEvent(
        new CustomEvent("atelier:goto-line", {
          detail: {
            workspaceId: WS,
            path: "/p/README.md",
            line: 1,
            from: 0,
            to: 5,
            find: { search: "notes", caseSensitive: false, regexp: false, wholeWord: false },
          },
        }),
      );
    });
    expect(view.state.selection.main.from).toBe(0);
    fireEvent.keyDown(content, { key: "g", code: "KeyG", metaKey: true });
    await waitFor(() => expect(view.state.selection.main.from).toBe(6));
    setPlatformForTests(null);
  });
});
