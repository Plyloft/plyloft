// 1.168.1 (C2): Setup's rail cut "Where your projects live" to "Where your
// proje…" at the 240px rail. A step's name wraps onto a second line instead
// of being cut, with the number and the state word kept on its first line
// (CSS: jsdom has no layout, so the rules are read).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { SETUP_STEPS } from "../lib/setupSteps";

const css = readFileSync("src/components/ux/ux.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const rule = (selector: string) => {
  const at = css.indexOf(`\n${selector} {`);
  expect(at, selector).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf("}", at));
};

describe("Setup's step names fit the rail", () => {
  it("wraps a long name rather than cutting it", () => {
    const title = rule(".ux-step-title");
    expect(title).not.toMatch(/text-overflow:\s*ellipsis/);
    expect(title).not.toMatch(/white-space:\s*nowrap/);
    expect(title).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it("keeps the number and the state on the name's first line", () => {
    expect(rule(".ux-step")).toMatch(/align-items:\s*(flex-start|baseline)/);
  });

  it("has the step that was cut", () => {
    expect(SETUP_STEPS.map((s) => s.title)).toContain("Where your projects live");
  });
});
