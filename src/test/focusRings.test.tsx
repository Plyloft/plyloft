// The focus ring marks a control, clear of its content (the DS focus rule,
// UX-0.7). jsdom neither lays out nor matches :focus-visible, so these read
// the layer's CSS for the rule that paints — or doesn't paint — the ring.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const css = readFileSync("src/components/ux/ux.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** Every rule whose selector mentions `needle`, as "selector { body }". */
function rulesFor(needle: string): string[] {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => m[1].includes(needle))
    .map((m) => `${m[1].trim()} {${m[2]}}`);
}

describe("an opening row's ring (GH #314)", () => {
  it("sits outside the row, never inset over its label and chevron", () => {
    const rings = rulesFor(".ux-row--opens:has(.ux-row-open:focus-visible)");
    expect(rings.length).toBeGreaterThan(0);
    for (const r of rings) {
      expect(r).not.toMatch(/outline-offset:\s*calc\(-1/);
      expect(r).toMatch(/outline-offset:\s*var\(--focus-offset\)/);
    }
  });
});

describe("the card's Now title (GH #303)", () => {
  it("takes the landing focus without a ring, since it is not a control", () => {
    const [rule] = rulesFor('.ux-callout-title[tabindex="-1"]:focus-visible');
    expect(rule).toMatch(/outline:\s*none/);
    // (0,3,0) beats the page's `.ux-page :focus-visible` (0,2,0).
    expect(rule.split("{")[0].trim()).toBe('.ux-callout-title[tabindex="-1"]:focus-visible');
  });
});

describe("a sheet's surface (GH #319)", () => {
  it("anchors focus on open without a ring around the whole sheet", () => {
    const [rule] = rulesFor('.ux-sheet[tabindex="-1"]:focus-visible');
    expect(rule).toMatch(/outline:\s*none/);
    expect(rule.split("{")[0].trim()).toBe('.ux-sheet[tabindex="-1"]:focus-visible');
  });
});
