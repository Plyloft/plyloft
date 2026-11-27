// UX-0.6: the void theme gets a dark editor. It used CodeMirror's light
// default (dark syntax colours meant for a white page) on void's black canvas.
import { describe, expect, it } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorPanel } from "../components/EditorPanel";
import { useEditor } from "../store/editorStore";
import { useSettings } from "../store/settingsStore";
import { act, nextFrame, renderUi } from "./render";

const WS = "ws-void";
const FILE = "/Users/someone/code/project/a.ts";

function setTheme(theme: "light" | "dark" | "void") {
  act(() => {
    useSettings.setState((s) => ({
      settings: {
        ...s.settings,
        appearance: { ...s.settings.appearance, theme },
      },
    }));
  });
}

function isDark(container: HTMLElement): boolean {
  const el = container.querySelector<HTMLElement>(".cm-editor");
  const view = el && EditorView.findFromDOM(el);
  if (!view) throw new Error("no CodeMirror view");
  return view.state.facet(EditorView.darkTheme);
}

describe("the editor theme", () => {
  it("is dark in void and dark, light in light", async () => {
    useEditor.getState().open(WS, FILE, "const a = 1;\n", null);
    useEditor.getState().setActive(WS, FILE);
    setTheme("void");
    const r = renderUi(<EditorPanel workspaceId={WS} />);
    await nextFrame();
    expect(isDark(r.container)).toBe(true);

    setTheme("light");
    await nextFrame();
    expect(isDark(r.container)).toBe(false);

    setTheme("dark");
    await nextFrame();
    expect(isDark(r.container)).toBe(true);
  });
});

describe("the Plyloft editor theme (GH #265)", () => {
  it("draws the canvas and the syntax from tokens, not One Dark's slab", async () => {
    useEditor.getState().open(WS, "/p/README.md", "# Heading\n\n<!-- a comment -->\n", null);
    useEditor.getState().setActive(WS, "/p/README.md");
    setTheme("void");
    renderUi(<EditorPanel workspaceId={WS} />);
    await nextFrame();
    const css = [...document.querySelectorAll("style")].map((s) => s.textContent).join("\n");
    expect(css).toContain("var(--term-bg)");
    expect(css).toContain("var(--syntax-comment)");
    expect(css).toContain("var(--syntax-heading)");
    expect(css).not.toMatch(/#282c34|#7d8799|#e06c75/i);
  });
});
