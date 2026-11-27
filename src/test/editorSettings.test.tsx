// GH #205: Settings › Code › Line numbers and Tab size reach every open editor,
// live, the way Wrap long lines already did. The real `EditorPanel` with a real
// CodeMirror view; the setting is changed in the settings store, which is what
// the This-Mac page writes.
//
//  1. Line numbers off → the gutter's numbers go from the file that is showing,
//     on → they come back; the same `.cm-editor` node throughout (no remount).
//  2. Tab size → `tabSize` and `indentUnit` of the showing state, and a Tab
//     press inserts that many spaces; same node throughout.
//  3. A file that waited in another tab (GH #170: its own `EditorState`) gets
//     both changes when it is switched back in.
//  4. Review 1 (m2): a tab-indented file keeps tabs — Tab and Enter insert "\t".
//  5. A space-indented file: Enter in a block indents by N spaces.
//  Test 1 also holds the gutter order: numbers, then fold markers (M1).
import { describe, expect, it } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { getIndentUnit, indentUnit } from "@codemirror/language";
import { EditorPanel } from "../components/EditorPanel";
import { useEditor } from "../store/editorStore";
import { useSettings } from "../store/settingsStore";
import { act, fireEvent, nextFrame, renderUi, screen, waitFor } from "./render";

const WS = "ws-editor-settings";
const A = "/Users/someone/code/project/a.ts";
const B = "/Users/someone/code/project/b.ts";
const A_TEXT = "const a = 1;\n";
const B_TEXT = "const b = 2;\n";

function editorEl(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>(".cm-editor");
  if (!el) throw new Error("no CodeMirror editor");
  return el;
}

function view(container: HTMLElement): EditorView {
  const v = EditorView.findFromDOM(editorEl(container));
  if (!v) throw new Error("no CodeMirror view");
  return v;
}

function hasLineNumbers(container: HTMLElement): boolean {
  return container.querySelector(".cm-lineNumbers") !== null;
}

/** The gutters as drawn, left to right (review 1, M1). */
function gutterOrder(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".cm-gutters > .cm-gutter")].map((g) =>
    g.classList.contains("cm-lineNumbers")
      ? "lineNumbers"
      : g.classList.contains("cm-foldGutter")
        ? "fold"
        : "other",
  );
}

function setEditor(patch: Partial<{ tabSize: number; lineNumbers: boolean }>) {
  act(() =>
    useSettings.setState((s) => ({
      settings: { ...s.settings, editor: { ...s.settings.editor, ...patch } },
    })),
  );
}

function content(path: string): string | undefined {
  return useEditor.getState().byWorkspace[WS]?.openFiles.find((f) => f.path === path)?.content;
}

async function renderWith(active: string, files: [string, string][] = [[A, A_TEXT], [B, B_TEXT]]) {
  for (const [path, text] of files) useEditor.getState().open(WS, path, text, null);
  useEditor.getState().setActive(WS, active);
  const r = renderUi(<EditorPanel workspaceId={WS} />, {
    fixtures: { fs_write_text_file: () => null },
  });
  await nextFrame();
  return r;
}

describe("Settings › Code reaches the open editor (GH #205)", () => {
  it("1. line numbers off and on again: gutter goes and comes back, no remount", async () => {
    const r = await renderWith(A);
    const mounted = editorEl(r.container);
    const v = view(r.container);
    expect(hasLineNumbers(r.container)).toBe(true);
    // Numbers first, fold markers after them, as before the setting existed.
    expect(gutterOrder(r.container)).toEqual(["lineNumbers", "fold"]);

    setEditor({ lineNumbers: false });
    await nextFrame();
    expect(hasLineNumbers(r.container)).toBe(false);
    // The fold gutter is not the setting's to remove.
    expect(r.container.querySelector(".cm-foldGutter")).not.toBeNull();
    expect(editorEl(r.container)).toBe(mounted);
    expect(view(r.container)).toBe(v);
    expect(v.state.doc.toString()).toBe(A_TEXT);

    setEditor({ lineNumbers: true });
    await nextFrame();
    expect(hasLineNumbers(r.container)).toBe(true);
    // Back in the same place, not after the fold gutter.
    expect(gutterOrder(r.container)).toEqual(["lineNumbers", "fold"]);
    expect(editorEl(r.container)).toBe(mounted);
    expect(view(r.container)).toBe(v);
  });

  it("2. tab size sets tabSize and indentUnit, and Tab inserts that many spaces, no remount", async () => {
    const r = await renderWith(A);
    const mounted = editorEl(r.container);
    const v = view(r.container);
    // The default is 2 (CodeMirror's own is 4: a tab now draws 2 wide until
    // the setting says otherwise).
    expect(v.state.facet(EditorState.tabSize)).toBe(2);
    expect(getIndentUnit(v.state)).toBe(2);

    setEditor({ tabSize: 4 });
    await nextFrame();
    expect(editorEl(r.container)).toBe(mounted);
    expect(view(r.container)).toBe(v);
    expect(v.state.facet(EditorState.tabSize)).toBe(4);
    expect(getIndentUnit(v.state)).toBe(4);

    // Tab at the start of the line indents by one unit: four spaces, not a tab.
    act(() => v.dispatch({ selection: { anchor: 0 } }));
    v.focus();
    fireEvent.keyDown(v.contentDOM, { key: "Tab", code: "Tab", keyCode: 9 });
    await waitFor(() => expect(content(A)).toBe("    " + A_TEXT));

    setEditor({ tabSize: 3 });
    await nextFrame();
    expect(v.state.facet(EditorState.tabSize)).toBe(3);
    expect(getIndentUnit(v.state)).toBe(3);
    expect(editorEl(r.container)).toBe(mounted);
  });

  it("3. a file that waited in another tab gets both settings on switch-in", async () => {
    const r = await renderWith(A);
    const mounted = editorEl(r.container);

    // B is shown once, so it has a stored state of its own, then A again.
    await r.user.click(screen.getByText("b.ts", { selector: ".tab-name" }));
    await nextFrame();
    await r.user.click(screen.getByText("a.ts", { selector: ".tab-name" }));
    await nextFrame();
    expect(view(r.container).state.doc.toString()).toBe(A_TEXT);

    setEditor({ lineNumbers: false, tabSize: 6 });
    await nextFrame();

    await r.user.click(screen.getByText("b.ts", { selector: ".tab-name" }));
    await nextFrame();
    const v = view(r.container);
    expect(v.state.doc.toString()).toBe(B_TEXT);
    expect(hasLineNumbers(r.container)).toBe(false);
    expect(v.state.facet(EditorState.tabSize)).toBe(6);
    expect(getIndentUnit(v.state)).toBe(6);
    expect(editorEl(r.container)).toBe(mounted);
  });

  it("4. a tab-indented file keeps tabs; tab size only sets how wide they draw", async () => {
    const MAKE = "/Users/someone/code/project/Makefile.txt";
    const MAKE_TEXT = "all:\n\tcc -o x x.c\n\tstrip x\n";
    const r = await renderWith(MAKE, [[MAKE, MAKE_TEXT]]);
    const v = view(r.container);
    expect(v.state.facet(indentUnit)).toBe("\t");
    expect(getIndentUnit(v.state)).toBe(2);

    setEditor({ tabSize: 4 });
    await nextFrame();
    expect(v.state.facet(indentUnit)).toBe("\t");
    expect(getIndentUnit(v.state)).toBe(4);

    // Tab at the start of the recipe's first line adds a tab, not spaces.
    act(() => v.dispatch({ selection: { anchor: v.state.doc.line(2).from } }));
    fireEvent.keyDown(v.contentDOM, { key: "Tab", code: "Tab", keyCode: 9 });
    await waitFor(() => expect(content(MAKE)).toBe("all:\n\t\tcc -o x x.c\n\tstrip x\n"));

    // Enter at the end of the last recipe line continues it with a tab.
    act(() => v.dispatch({ selection: { anchor: v.state.doc.line(3).to } }));
    fireEvent.keyDown(v.contentDOM, { key: "Enter", code: "Enter", keyCode: 13 });
    await waitFor(() => expect(content(MAKE)).toBe("all:\n\t\tcc -o x x.c\n\tstrip x\n\t\n"));
  });

  it("5. a space-indented file: Enter inside a block indents by N spaces", async () => {
    const F = "/Users/someone/code/project/f.ts";
    const F_TEXT = "function f() {\n  return 1;\n}\n";
    const r = await renderWith(F, [[F, F_TEXT]]);
    const v = view(r.container);
    setEditor({ tabSize: 4 });
    await nextFrame();
    expect(v.state.facet(indentUnit)).toBe("    ");

    act(() => v.dispatch({ selection: { anchor: v.state.doc.line(1).to } }));
    fireEvent.keyDown(v.contentDOM, { key: "Enter", code: "Enter", keyCode: 13 });
    await waitFor(() => expect(content(F)).toBe("function f() {\n    \n  return 1;\n}\n"));
  });
});
