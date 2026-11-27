// GH #307: a flow's chosen option (Release › "On this Mac only") is marked by
// a radio dot beside its words and the accent border — never a coloured left
// edge (DS Space & shape: "No coloured left borders").
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ChoiceList } from "../components/ux";
import { renderUi, screen } from "./render";

const css = readFileSync("src/components/ux/ux.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function rulesFor(selector: string): string[] {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => m[1].split(",").some((s) => s.trim() === selector))
    .map((m) => m[2]);
}

describe("a chosen option (GH #307)", () => {
  it("draws no coloured left edge", () => {
    const on = rulesFor(".ux-choice--on");
    expect(on.length).toBeGreaterThan(0);
    for (const body of on) expect(body).not.toMatch(/box-shadow|border-left/);
  });

  it("carries a radio dot, filled only on the chosen one", () => {
    renderUi(
      <ChoiceList
        label="How far it goes"
        value="local"
        onChange={() => {}}
        options={[
          { value: "local", label: "On this Mac only", hint: "Nothing is pushed." },
          { value: "push", label: "Tag and push", hint: "Pushes the tag." },
        ]}
      />,
    );
    const chosen = screen.getByRole("radio", { name: /On this Mac only/ });
    const other = screen.getByRole("radio", { name: /Tag and push/ });
    expect(chosen.querySelector(".ux-choice-radio")).toBeTruthy();
    expect(other.querySelector(".ux-choice-radio")).toBeTruthy();
    expect(rulesFor(".ux-choice--on > .ux-choice-radio").join("")).toMatch(/background/);
  });
});
