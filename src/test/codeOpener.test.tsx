// GH #266: Code's empty page on the one scale, pointing nowhere stale.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CodeOpener } from "../components/CodeOpener";
import { useWorkspaces } from "../store/workspaceStore";
import { act, renderUi, screen } from "./render";

describe("the Code opener (GH #266)", () => {
  it("has no Activity footnote and draws no text glyphs", () => {
    act(() =>
      useWorkspaces.setState({
        workspaces: [
          { id: "w1", name: "Lyra", cwd: "/p", createdAt: 1, lastOpenedAt: 1, openFiles: [], activeFile: null },
        ],
        activeId: "w1",
      }),
    );
    const { container } = renderUi(<CodeOpener workspaceId="w1" />);
    expect(container.textContent).not.toMatch(/Activity|⌘⌥5|≋|\{ \}|⌕/);
    expect(container.textContent).toContain("Find any file in Lyra");
    const jump = screen.getByRole("button", { name: /Go to file/ });
    expect(jump.querySelector("svg")).toBeTruthy();
    expect(jump.querySelector("kbd")?.textContent).toBe("⌘P");
    expect(container.querySelectorAll("svg")).toHaveLength(2);
  });

  it("rings the field only on focus, on the type scale", () => {
    const css = readFileSync("src/components/code.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => m[1].includes(".code-opener"));
    expect(rules.length).toBeGreaterThan(4);
    for (const [, sel, body] of rules) {
      expect(`${sel}{${body}}`).not.toMatch(/box-shadow|font-size:\s*\d+px|font-weight:\s*700/);
    }
  });

  it("is said nowhere in src as Activity (⌘⌥5)", () => {
    for (const f of ["src/components/CodeOpener.tsx", "src/components/SwarmRunViews.tsx"]) {
      expect(readFileSync(f, "utf8")).not.toContain("Activity (⌘⌥5)");
    }
  });
});
