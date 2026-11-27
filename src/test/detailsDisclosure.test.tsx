// GH #270: `Details` is a quiet disclosure — the Lucide expand chevron and the
// word in small muted type — whose body opens without a frame, so it fits in
// a hairline row. Only the dense error block keeps a box. jsdom lays nothing
// out, so the box is read from the layer's CSS; the markup is rendered.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Details } from "../components/ux";
import { renderUi } from "./render";

const css = readFileSync("src/components/ux/ux.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations of the rule whose selector list is exactly `selector`. */
function rule(selector: string): string {
  const at = css.indexOf(`\n${selector} {`);
  expect(at, selector).toBeGreaterThanOrEqual(0);
  return css.slice(at, css.indexOf("}", at));
}

describe("Details (GH #270)", () => {
  it("draws no box of its own", () => {
    const own = rule(".ux-details");
    expect(own).not.toMatch(/\bborder\b|background|padding/);
  });

  it("keeps the box only in the dense error block", () => {
    const dense = rule(".ux-error--dense .ux-details,\n.ux-error-details--dense .ux-details");
    expect(dense).toMatch(/border: 1px solid var\(--border\)/);
  });

  it("opens under a row, across its width", () => {
    expect(css).toMatch(/\.ux-row > \.ux-row-side:has\(\.ux-details\[open\]\) \{\s*flex-basis: 100%;/);
  });

  it("summarises with the expand icon and the word, closed by default", () => {
    const r = renderUi(<Details>raw output</Details>);
    const details = r.container.querySelector<HTMLDetailsElement>("details.ux-details")!;
    expect(details.open).toBe(false);
    const summary = details.querySelector("summary.ux-details-summary")!;
    expect(summary.textContent).toBe("Details");
    expect(summary.querySelector("svg.lucide-chevron-down")).not.toBeNull();
  });
});
