// GH #249: one long column does not move the others. The row of columns
// only scrolls sideways; each column is capped at the stage's height and
// scrolls its own cards, so its heading and count stay in view.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const css = readFileSync("src/components/board.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function rule(selector: string): string {
  const at = css.indexOf(`\n${selector} {`);
  expect(at, selector).toBeGreaterThanOrEqual(0);
  return css.slice(at, css.indexOf("}", at));
}

describe("the Board's columns scroll one by one (GH #249)", () => {
  it("does not scroll the row of columns vertically", () => {
    const row = rule(".board-columns");
    expect(row).toMatch(/overflow-y:\s*hidden/);
    expect(row).toMatch(/overflow-x:\s*auto/);
  });

  it("caps each column and scrolls its body under a fixed heading", () => {
    expect(rule(".board-column")).toMatch(/max-height:\s*100%/);
    expect(rule(".board-column")).toMatch(/min-height:\s*0/);
    expect(rule(".board-column-heading")).toMatch(/flex:\s*none/);
    expect(rule(".board-column-body")).toMatch(/overflow-y:\s*auto/);
  });
});
