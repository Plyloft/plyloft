// GH #248: the ListView's title cell stays a table cell — its column takes
// the free width, it keeps the row's hairline, the row grows to two lines —
// and the two-line clamp sits on a span inside it. The Board's List and
// History both draw this ListView, so both get it.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ListView } from "../components/ux";
import { renderUi, screen, within } from "./render";

const css = readFileSync("src/components/ux/ux.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function rule(selector: string): string {
  const at = css.indexOf(`\n${selector} {`);
  expect(at, selector).toBeGreaterThanOrEqual(0);
  return css.slice(at, css.indexOf("}", at));
}

type Row = { id: string; title: string };
const rows: Row[] = [
  { id: "1", title: "Settings search: Italian, French, German and Spanish words find their settings too" },
  { id: "2", title: "Toasts" },
];

describe("the ListView title (GH #248)", () => {
  it("keeps the cell a table cell with its hairline; the clamp is on a span", () => {
    const cell = rule(".ux-list-td--primary");
    expect(cell).not.toMatch(/display|line-clamp|overflow:\s*hidden|border-bottom:\s*0/);
    expect(rule(".ux-list-clamp")).toMatch(/-webkit-line-clamp:\s*2/);
  });

  it("wraps each title, openable or not, in the clamp", () => {
    const view = (onOpen?: (r: Row) => void) => (
      <ListView<Row>
        label="Cards"
        columns={[
          { key: "title", label: "Title", primary: true, cell: (r) => r.title },
          { key: "status", label: "Status", cell: () => "Draft" },
        ]}
        groups={[{ key: "all", label: "", rows }]}
        onOpen={onOpen}
      />
    );
    const r = renderUi(view(() => {}));
    const table = screen.getByRole("table", { name: "Cards" });
    for (const td of table.querySelectorAll(".ux-list-td--primary")) {
      expect(td.querySelector(".ux-list-open > .ux-list-clamp")).not.toBeNull();
    }
    expect(within(table).getByRole("button", { name: rows[0].title })).toBeTruthy();
    r.rerender(view());
    for (const td of table.querySelectorAll(".ux-list-td--primary")) {
      expect(td.firstElementChild?.className).toBe("ux-list-clamp");
    }
  });
});

describe("the columns' widths (GH #248, the List's Title at ~170 px)", () => {
  it("lays the table out fixed: widths from the scale, the title takes the rest", () => {
    expect(rule(".ux-list")).toMatch(/table-layout:\s*fixed/);
    expect(rule(".ux-list-th--primary")).toMatch(/width:\s*auto/);
    for (const w of ["xs", "sm", "md", "lg"]) {
      expect(rule(`.ux-list-col--${w}`)).toMatch(new RegExp(`width: var\\(--list-col-${w}\\)`));
    }
    // A value is one line, cut at its column — never the column's width.
    expect(rule(".ux-list-cell")).toMatch(/overflow:\s*hidden;[\s\S]*text-overflow:\s*ellipsis/);
  });

  it("gives a value cell its width class and its whole text on hover", () => {
    const blocked = "Blocked by “Inbox: group rows that wait on the same card” and 1 more";
    renderUi(
      <ListView<Row>
        label="Cards"
        columns={[
          { key: "title", label: "Title", primary: true, cell: (r) => r.title },
          { key: "status", label: "Status", width: "lg", tooltip: () => blocked, cell: () => blocked },
          { key: "updated", label: "Updated", width: "sm", cell: () => "1h ago" },
        ]}
        groups={[{ key: "all", label: "", rows }]}
      />,
    );
    const heads = [...document.querySelectorAll("th.ux-list-th")].map((th) => th.className);
    expect(heads).toEqual([
      "ux-list-th ux-list-th--primary",
      "ux-list-th ux-list-col--lg",
      "ux-list-th ux-list-col--sm",
    ]);
    const cell = screen.getAllByText(blocked)[0];
    expect(cell.className).toBe("ux-list-cell");
    expect(cell.getAttribute("title")).toBe(blocked);
  });

  it("spans the Board on the Board's List; History keeps its reading column", () => {
    const board = readFileSync("src/components/board.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(board).toMatch(/\.board-list \.ux-list-frame,\s*\.board-list \.ux-list \{\s*max-width: none;/);
    const list = readFileSync("src/components/BoardList.tsx", "utf8");
    expect(list).toMatch(/key: "status",[\s\S]*?width: "lg",\s*tooltip: \(r\) => machineWords\(r\.status\)/);
    // CL-10: the stage view's Attention column fits "Needs you" (md, 144px).
    expect(list).toMatch(/key: "attention",[\s\S]*?width: "md" as const,[\s\S]*?tooltip:/);
    const history = readFileSync("src/components/ActivityView.tsx", "utf8");
    expect(history).toMatch(/key: "workspace",[\s\S]*?width: "md"/);
  });
});
