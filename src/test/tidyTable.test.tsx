// A0 (owner, 2026-10-31): tidy tables. A `Group` is a table whose rows share
// its columns — main | value | action | more — so every action button has the
// same width and right edge, ⋯ keeps one slot, and the whole table wraps at
// once. jsdom lays nothing out, so this asserts the structure the stylesheet
// lines up (ux.css "Tidy tables"; src/lib/tidyRows.test.ts reads the CSS).
import { afterEach, describe, expect, it } from "vitest";
import { act } from "@testing-library/react";
import { CBtn, DangerZone, EmptyState, Group, MoreMenu, Row, RowValue, Toggle } from "../components/ux";
import { renderUi } from "./render";

const cells = (row: Element) =>
  Array.from(row.querySelectorAll(":scope > .ux-row-side > .ux-row-fieldset > .ux-row-side-inner > .ux-row-cell")).map(
    (c) => c.className,
  );

/** jsdom lays nothing out: give the table a width and every cell a width,
 *  as a real web view would measure them. Undone after each test. */
const undo: (() => void)[] = [];
function stubLayout(size: { content: number; cell: number }) {
  const { cell } = size;
  const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => size.content });
  const rect = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function () {
    return { width: cell, height: 30, top: 0, left: 0, right: cell, bottom: 30, x: 0, y: 0, toJSON() {} } as DOMRect;
  };
  undo.push(() => {
    if (width) Object.defineProperty(HTMLElement.prototype, "clientWidth", width);
    else delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
    HTMLElement.prototype.getBoundingClientRect = rect;
  });
}
function stubNoSubgrid() {
  const had = Object.getOwnPropertyDescriptor(globalThis, "CSS");
  Object.defineProperty(globalThis, "CSS", {
    configurable: true,
    writable: true,
    value: { supports: (prop: string, value?: string) => !(prop === "grid-template-columns" && value === "subgrid") },
  });
  undo.push(() => {
    if (had) Object.defineProperty(globalThis, "CSS", had);
    else delete (globalThis as { CSS?: unknown }).CSS;
  });
}
afterEach(() => {
  while (undo.length) undo.pop()!();
});

const twoRows = (
  <Group label="Shipping">
    <Row kind="procedure" label="Release" action={<CBtn>Open</CBtn>} />
    <Row kind="procedure" label="Bring in main's changes" action={<CBtn>Bring in</CBtn>} />
  </Group>
);

describe("Tidy tables (A0)", () => {
  it("draws a Group as a table and each Row as cells", () => {
    const r = renderUi(
      <Group label="Shipping">
        <Row kind="procedure" label="Release" action={<CBtn>Open</CBtn>} />
        <Row kind="value" label="Version">
          <RowValue>1.174.0</RowValue>
        </Row>
      </Group>,
    );
    const group = r.container.querySelector(".ux-group")!;
    expect(group.classList.contains("ux-table")).toBe(true);
    const rows = group.querySelectorAll(":scope > .ux-row");
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.classList.contains("ux-row--cells")).toBe(true);
      // Every cell is there even when the row leaves it empty.
      expect(cells(row)).toEqual([
        "ux-row-cell ux-row-cell--value",
        "ux-row-cell ux-row-cell--action",
        "ux-row-cell ux-row-cell--more",
      ]);
    }
    const [release, version] = rows;
    expect(release.querySelector(".ux-row-cell--action")!.textContent).toBe("Open");
    expect(release.querySelector(".ux-row-cell--value")!.childNodes).toHaveLength(0);
    // A value sits in the value column, never the action's.
    expect(version.querySelector(".ux-row-cell--value")!.textContent).toBe("1.174.0");
    expect(version.querySelector(".ux-row-cell--action")!.childNodes).toHaveLength(0);
  });

  it("keeps the ⋯ slot in every row once one row has it", () => {
    const r = renderUi(
      <Group label="Areas">
        <Row kind="item" label="app" action={<CBtn>Open</CBtn>} />
        <Row
          kind="item"
          label="site"
          action={<CBtn>Bring in</CBtn>}
          more={<MoreMenu label="More for site" items={[{ label: "Remove", onSelect: () => {} }]} />}
        />
      </Group>,
    );
    const group = r.container.querySelector(".ux-group")!;
    expect(group.getAttribute("data-has-more")).toBe("true");
    for (const row of group.querySelectorAll(":scope > .ux-row")) {
      expect(row.querySelector(":scope .ux-row-cell--more")).not.toBeNull();
    }
  });

  it("reserves no ⋯ slot when no row has one", () => {
    const r = renderUi(
      <Group label="This Mac">
        <Row kind="toggle" label="Notify">
          <Toggle checked={false} onChange={() => {}} />
        </Row>
        <Row kind="procedure" label="Agent instructions" action={<CBtn>Set up</CBtn>} />
      </Group>,
    );
    expect(r.container.querySelector(".ux-group")!.hasAttribute("data-has-more")).toBe(false);
  });

  it("notices a ⋯ that arrives later", async () => {
    const view = (more: boolean) => (
      <Group label="Copies">
        <Row kind="item" label="one" action={<CBtn>Open</CBtn>} />
        <Row
          kind="item"
          label="two"
          action={<CBtn>Open</CBtn>}
          more={more ? <MoreMenu label="More for two" items={[{ label: "Remove", onSelect: () => {} }]} /> : null}
        />
      </Group>
    );
    const r = renderUi(view(false));
    const group = r.container.querySelector(".ux-group")!;
    expect(group.hasAttribute("data-has-more")).toBe(false);
    r.rerender(view(true));
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });
    expect(group.getAttribute("data-has-more")).toBe("true");
  });

  it("lets a row with nothing on its side take the row", () => {
    const r = renderUi(
      <Group label="Notes">
        <Row kind="value" label="Nothing to set here" hint="Just words." />
      </Group>,
    );
    const row = r.container.querySelector(".ux-row")!;
    expect(row.classList.contains("ux-row--no-side")).toBe(true);
    expect(row.querySelector(".ux-row-side")).toBeNull();
  });

  it("keeps the chevron of a row that opens in the ⋯ column", () => {
    const r = renderUi(
      <Group label="Files">
        <Row kind="value" label="Version files" onOpen={() => {}}>
          <RowValue>5 files</RowValue>
        </Row>
      </Group>,
    );
    const more = r.container.querySelector(".ux-row-cell--more")!;
    expect(more.querySelector(".ux-row-chevron")).not.toBeNull();
    expect(r.container.querySelector(".ux-group")!.getAttribute("data-has-more")).toBe("true");
  });

  it("draws the danger zone as a table too, and the empty state not", () => {
    const r = renderUi(
      <>
        <DangerZone>
          <Row kind="procedure" label="Remove the workspace" action={<CBtn tone="danger">Remove</CBtn>} />
        </DangerZone>
        <EmptyState>No areas yet.</EmptyState>
      </>,
    );
    expect(r.container.querySelector(".ux-danger-zone")!.classList.contains("ux-table")).toBe(true);
    expect(r.container.querySelector(".ux-empty")!.classList.contains("ux-table")).toBe(false);
  });

  it("leaves a row outside a table laid out on its own", () => {
    const r = renderUi(<Row kind="procedure" label="Alone" action={<CBtn>Open</CBtn>} />);
    const row = r.container.querySelector(".ux-row")!;
    expect(row.parentElement!.classList.contains("ux-table")).toBe(false);
    expect(row.querySelector(".ux-row-cell--action")!.textContent).toBe("Open");
  });

  it("marks a row with no action, so its value spans the action column", () => {
    const r = renderUi(
      <Group label="This Mac">
        <Row kind="toggle" label="Notify">
          <Toggle checked={false} onChange={() => {}} />
        </Row>
        <Row kind="procedure" label="Agent instructions" action={<CBtn>Set up</CBtn>} />
        <Row kind="procedure" label="Off" action={false}>
          <RowValue>Nothing to do</RowValue>
        </Row>
      </Group>,
    );
    const rows = r.container.querySelectorAll(".ux-row");
    expect([...rows].map((row) => row.classList.contains("ux-row--no-action"))).toEqual([true, false, true]);
  });

  it("keeps a disabled row's button disabled", () => {
    const r = renderUi(
      <Group label="Setup">
        <Row kind="procedure" label="Disabled" hint="Why it is off." disabled action={<CBtn>Set up</CBtn>} />
      </Group>,
    );
    const button = r.container.querySelector(".ux-row-cell--action button")!;
    expect(button.matches(":disabled")).toBe(true);
  });

  it("stacks the whole table at once, never a row on its own", () => {
    // 300 px of row and 200 px cells leave far less than 260 px of label.
    stubLayout({ content: 300, cell: 200 });
    const r = renderUi(twoRows);
    const group = r.container.querySelector(".ux-group")!;
    expect(group.classList.contains("ux-table--stacked")).toBe(true);
    expect(r.container.querySelectorAll(".ux-row--stacked")).toHaveLength(0);
  });

  it("does not stack on a wide table, and hands the action column its width", () => {
    stubLayout({ content: 900, cell: 80 });
    const r = renderUi(twoRows);
    const group = r.container.querySelector<HTMLElement>(".ux-group")!;
    expect(group.classList.contains("ux-table--stacked")).toBe(false);
    // The widest action plus its gap; with subgrid nothing else is set.
    expect(group.style.getPropertyValue("--ux-action-w")).toBe("88px");
    expect(group.style.getPropertyValue("--ux-value-w")).toBe("");
  });

  it("keeps its last layout while its host is hidden (no width)", async () => {
    // Wide, so not stacked; a zero width would read as "stack" if it counted.
    const size = { content: 900, cell: 80 };
    stubLayout(size);
    const r = renderUi(twoRows);
    const group = r.container.querySelector(".ux-group")!;
    expect(group.classList.contains("ux-table--stacked")).toBe(false);
    // The host is hidden (a workspace in the background): no width at all.
    size.content = 0;
    await act(async () => {
      group.querySelector(".ux-row-label-text")!.append(" changed");
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });
    // No flash of a stacked table: it keeps the layout it had.
    expect(group.classList.contains("ux-table--stacked")).toBe(false);
    expect(group.getAttribute("data-has-more")).toBeNull();
  });

  it("hands every column its measured width where subgrid is missing", () => {
    stubNoSubgrid();
    stubLayout({ content: 900, cell: 80 });
    const r = renderUi(
      <Group label="Copies">
        <Row kind="item" label="one" action={<CBtn>Open</CBtn>} />
        <Row
          kind="item"
          label="two"
          action={<CBtn>Open</CBtn>}
          more={<MoreMenu label="More for two" items={[{ label: "Remove", onSelect: () => {} }]} />}
        />
      </Group>,
    );
    const group = r.container.querySelector<HTMLElement>(".ux-group")!;
    expect(group.style.getPropertyValue("--ux-action-w")).toBe("88px");
    expect(group.style.getPropertyValue("--ux-value-w")).toBe("0px");
    expect(group.style.getPropertyValue("--ux-more-w")).toBe("88px");
  });
});
