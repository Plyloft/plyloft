// GH #172, converting GH #142's source contract into behaviour: the real
// `EditorPanel` with a real CodeMirror view, a tab opened read-only through the
// editor store the way the Library opens one. ⌘S on it reaches no
// `fs_write_text_file`, and typing into it changes nothing. The writable tab
// beside it is the control — the same keystrokes there do edit and do save —
// so the refusals are the read-only flag's doing, not jsdom's.
// `readOnlyFile.test.ts` keeps the rule and the source shape.
import { describe, expect, it } from "vitest";
import { EditorPanel } from "../components/EditorPanel";
import { useEditor } from "../store/editorStore";
import { fireEvent, nextFrame, renderUi, tauri, waitFor } from "./render";

const WS = "ws-test";
const SKILL = "/Users/someone/Library/Application Support/com.mbadv.ply/mirror/skills/x/SKILL.md";
const CHECKOUT = "/Users/someone/code/project/notes.txt";

const fixtures = {
  fs_write_text_file: () => null,
};

function file(path: string) {
  return useEditor.getState().byWorkspace[WS]?.openFiles.find((f) => f.path === path);
}

function content(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>(".cm-content");
  if (!el) throw new Error("no CodeMirror content element");
  return el;
}

function pressSave(el: HTMLElement) {
  fireEvent.keyDown(el, { key: "s", code: "KeyS", keyCode: 83, metaKey: true });
}

async function openAndRender(path: string, readOnly: boolean) {
  useEditor
    .getState()
    .open(
      WS,
      path,
      "original line\n",
      readOnly ? { place: "mirror", line: "Reading the integration branch mirror." } : null,
    );
  const r = renderUi(<EditorPanel workspaceId={WS} />, { fixtures });
  await nextFrame();
  return r;
}

describe("a read-only editor tab", () => {
  it("⌘S on it invokes no fs_write_text_file", async () => {
    const { container } = await openAndRender(SKILL, true);
    const cm = content(container);
    expect(cm.textContent).toBe("original line");
    expect(cm.getAttribute("contenteditable")).toBe("false");

    pressSave(cm);
    await nextFrame();
    expect(tauri().callsOf("fs_write_text_file")).toEqual([]);
    expect(file(SKILL)?.initialContent).toBe("original line\n");
  });

  it("typing into it changes nothing", async () => {
    const { container, user } = await openAndRender(SKILL, true);
    const cm = content(container);

    await user.click(cm);
    await user.keyboard("typed");
    await user.type(cm, "more");
    await nextFrame();
    expect(cm.textContent).toBe("original line");
    expect(file(SKILL)?.content).toBe("original line\n");
  });
});

describe("a writable editor tab (the control)", () => {
  it("takes typing and saves it on ⌘S", async () => {
    const { container, user } = await openAndRender(CHECKOUT, false);
    const cm = content(container);
    expect(cm.getAttribute("contenteditable")).toBe("true");

    await user.click(cm);
    await user.keyboard("typed ");
    await waitFor(() => expect(file(CHECKOUT)?.content).toContain("typed "));

    pressSave(cm);
    await waitFor(() => expect(tauri().callsOf("fs_write_text_file")).toHaveLength(1));
    const [call] = tauri().callsOf("fs_write_text_file");
    expect(call.args.path).toBe(CHECKOUT);
    expect(String(call.args.content)).toContain("typed ");
  });
});
