// GH #311: on the Inbox and History the title, the summary sentence and the
// groups share one left edge. The body column is not centred on its own; it
// starts where the header puts the title — the header's inset, the sidebar
// toggle and their gap (or the traffic lights' room with the sidebar hidden).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const shell = strip(readFileSync("src/components/shell.css", "utf8"));
const ux = strip(readFileSync("src/components/ux/ux.css", "utf8"));
const app = strip(readFileSync("src/App.css", "utf8"));

function rule(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`);
  expect(at, selector).toBeGreaterThanOrEqual(0);
  return css.slice(at, css.indexOf("}", at));
}
const prop = (block: string, name: string) =>
  block.match(new RegExp(`(?:^|[\\s;{])${name}:\\s*([^;]+);`))?.[1].trim();
const token = (name: string) => app.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1].trim();

describe("the Inbox and History line up with their title (GH #311)", () => {
  it("derives the title's start from the header's own layout", () => {
    const header = rule(shell, "\n.shell-stage-header");
    const inset = prop(header, "padding")!.split(/\s+/)[3];
    const gap = prop(header, "gap");
    const toggle = prop(rule(shell, "\n.shell-icon-control"), "width");
    expect(token("--stage-title-start")).toBe(`calc(${inset} + ${toggle} + ${gap})`);
    const bare = rule(shell, '.shell-sidebar-slot[data-presentation="docked"])) .shell-stage-header');
    // W5: the room the traffic lights take, from the token — 84 px on the Mac.
    expect(prop(bare, "padding-left")).toBe("var(--traffic-light-inset)");
    expect(token("--traffic-light-inset")).toBe("84px");
    expect(token("--stage-title-start-bare")).toBe(
      `calc(var(--traffic-light-inset) + ${toggle} + ${gap})`,
    );
  });

  it("starts the body column there instead of centring it", () => {
    const column = rule(ux, ":is(.ux-inbox, .ux-history, .ux-library--single) .ux-page-column");
    expect(prop(column, "margin")).toBe("0");
    expect(prop(column, "padding-left")).toBe("var(--stage-title-start)");
    const bare = rule(ux, ":is(.ux-inbox, .ux-history, .ux-library--single)\n  .ux-page-column");
    expect(prop(bare, "padding-left")).toBe("var(--stage-title-start-bare)");
  });
});
