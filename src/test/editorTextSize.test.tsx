// QoL 1.168 (block 10, A7): Settings › Editor text size reaches the open
// editor live (a CSS variable on its host, one node throughout), and ⌘= /
// ⌘− / ⌘0 in the editor save it a step at a time.
import { describe, expect, it } from "vitest";
import { EditorPanel } from "../components/EditorPanel";
import { useEditor } from "../store/editorStore";
import { useSettings } from "../store/settingsStore";
import { act, fireEvent, nextFrame, renderUi, waitFor } from "./render";

const WS = "ws-editor-text-size";
const A = "/Users/someone/code/project/a.ts";

function host(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>(".editor-host");
  if (!el) throw new Error("no editor host");
  return el;
}

describe("Settings › Editor text size", () => {
  it("follows the setting live and answers ⌘= / ⌘0", async () => {
    act(() =>
      useSettings.setState((s) => ({ settings: { ...s.settings, editor: { ...s.settings.editor, textSize: null } } })),
    );
    useEditor.getState().open(WS, A, "const a = 1;\n", null);
    useEditor.getState().setActive(WS, A);
    const { container } = renderUi(<EditorPanel workspaceId={WS} />, {
      fixtures: { fs_write_text_file: () => null, settings_set: ({ settings }: { settings: unknown }) => settings },
    });
    await nextFrame();
    const node = container.querySelector(".cm-editor");
    expect(host(container).style.getPropertyValue("--ply-editor-text-size")).toBe("13px");

    act(() =>
      useSettings.setState((s) => ({ settings: { ...s.settings, editor: { ...s.settings.editor, textSize: 16 } } })),
    );
    expect(host(container).style.getPropertyValue("--ply-editor-text-size")).toBe("16px");

    const content = container.querySelector<HTMLElement>(".cm-content")!;
    await act(async () => {
      fireEvent.keyDown(content, { key: "=", metaKey: true });
    });
    await waitFor(() => expect(useSettings.getState().settings.editor.textSize).toBe(17));
    expect(host(container).style.getPropertyValue("--ply-editor-text-size")).toBe("17px");
    await act(async () => {
      fireEvent.keyDown(content, { key: "0", metaKey: true });
    });
    await waitFor(() => expect(useSettings.getState().settings.editor.textSize).toBe(null));
    expect(host(container).style.getPropertyValue("--ply-editor-text-size")).toBe("13px");
    // The text never changed and the view is the same node.
    expect(useEditor.getState().byWorkspace[WS]?.openFiles[0].content).toBe("const a = 1;\n");
    expect(container.querySelector(".cm-editor")).toBe(node);
  });
});
