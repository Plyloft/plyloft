// Integrated walk 2026-10-22: the Now sentence was squeezed to a word per line
// when four actions stood beside it. The sentence keeps a minimum width and
// the actions wrap beneath it (CSS: jsdom has no layout, so the rule is read).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { CardStateHeader } from "../components/CardStateHeader";
import { renderUi, screen } from "./render";

const css = readFileSync("src/components/ux/ux.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const rule = (selector: string) => {
  const at = css.indexOf(`${selector} {`);
  expect(at, selector).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf("}", at));
};

describe("the Now box's sentence keeps its width", () => {
  it("draws the sentence and the actions as siblings the wrap rules reach", () => {
    renderUi(
      <CardStateHeader
        state="changes-requested"
        label="Round 3's requested changes have not reached the Builder"
        actionId="send-handed-over"
        actionLabel="Send the findings to the Builder"
        helper="The Builder has not received them, and its session is closed. Resume the session or Start fresh first."
        tone="accent"
        runState="aborted"
        onAction={() => {}}
        secondary={{ label: "Agree with Claude, keep it as it is", onAction: () => {} }}
        tryIt={{ label: "Try it", onAction: () => {} }}
        seeChanges={{ label: "See the changes", onAction: () => {} }}
      />,
    );
    const callout = document.querySelector(".ux-card-now > .ux-callout")!;
    expect(callout).toBeTruthy();
    expect(callout.querySelector(":scope > .ux-callout-text")!.textContent).toContain("Round 3's requested changes");
    const actions = callout.querySelector(":scope > .ux-callout-actions")!;
    expect(actions.contains(screen.getByRole("button", { name: "See the changes" }))).toBe(true);
  });

  it("gives the text a minimum width and lets the row wrap", () => {
    expect(rule(".ux-card-now > .ux-callout")).toMatch(/flex-wrap: wrap;/);
    const text = rule(".ux-card-now > .ux-callout > .ux-callout-text");
    expect(text).toMatch(/min-width: min\(20rem, 100%\);/);
    expect(text).toMatch(/flex: 1 1 20rem;/);
    expect(rule(".ux-card-now > .ux-callout > .ux-callout-actions")).toMatch(/max-width: 100%;/);
  });
});
