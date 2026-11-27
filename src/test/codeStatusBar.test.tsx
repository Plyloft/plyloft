// GH #267: the editor's status bar is one line of what is useful — no
// absolute path, "Unsaved changes" only while there are some, Wrap a quiet
// pressed toggle, and no bar at all for a file Code could not open.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EditorPanel } from "../components/EditorPanel";
import { useEditor } from "../store/editorStore";
import { nextFrame, renderUi, screen } from "./render";

const WS = "ws-status";
const FILE = "/Users/someone/code/project/src/components/KanbanBoard.tsx";

function bar(): HTMLElement | null {
  return document.querySelector(".editor-statusbar");
}

describe("the editor's status bar (GH #267)", () => {
  it("shows no path and asks nothing of a clean file", async () => {
    useEditor.getState().open(WS, FILE, "line\n", null);
    renderUi(<EditorPanel workspaceId={WS} />);
    await nextFrame();
    expect(bar()!.textContent).not.toContain("/Users/");
    expect(bar()!.textContent).not.toMatch(/⌘S|saved/i);
    const wrap = screen.getByRole("button", { name: "Wrap" });
    expect(wrap.getAttribute("aria-pressed")).toBe("false");
    expect(wrap.className).not.toContain("active");
  });

  it("says Unsaved changes while there are some", async () => {
    useEditor.getState().open(WS, FILE, "line\n", null);
    renderUi(<EditorPanel workspaceId={WS} />);
    await nextFrame();
    useEditor.getState().setContent(WS, FILE, "line changed\n");
    await nextFrame();
    expect(bar()!.textContent).toContain("Unsaved changes · ⌘S");
  });

  it("is not drawn for a file Code could not open", async () => {
    useEditor.getState().openRefused(WS, "/p/logo.png", { kind: "binary", reason: "It is a binary file." });
    renderUi(<EditorPanel workspaceId={WS} />);
    await nextFrame();
    expect(bar()).toBeNull();
  });

  it("is one caption line on tokens", () => {
    const css = readFileSync("src/components/code.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const rule = (sel: string) =>
      [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((m) => m[1].trim() === sel)?.[2] ?? "";
    expect(rule(".editor-statusbar")).toMatch(/font-size:\s*var\(--type-caption\)/);
    expect(rule(".editor-statusbar-state")).toMatch(/white-space:\s*nowrap/);
    expect(rule(".editor-statusbar-actions")).toMatch(/flex:\s*0 0 auto/);
    expect(rule('.editor-statusbar-btn[aria-pressed="true"]')).toMatch(/var\(--selected\)/);
    const app = readFileSync("src/App.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(app).not.toMatch(/\.editor-statusbar/);
  });
});
