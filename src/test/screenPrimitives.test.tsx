// UX-2.3: the one-scale primitives render what the Design System v2 drew.
//
//  - ScreenHeader: the last crumb is the page, never a link; earlier crumbs
//    with a handler are buttons.
//  - Properties: label and value pairs as a description list.
//  - Callout: a warning is announced; `now` shows its state dot.
//  - Timeline: events in order, a link runs its handler.
//  - Popover: opens under its trigger and closes on Escape.
//  - ListView: sorts from the header, groups with counts, selects rows.
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  Callout,
  ListView,
  Popover,
  Properties,
  ScreenHeader,
  Timeline,
  type ListSort,
} from "../components/ux";
import { renderUi, screen, within } from "./render";

describe("ScreenHeader", () => {
  it("links every crumb but the page itself", async () => {
    const toWs = vi.fn();
    const r = renderUi(
      <ScreenHeader
        crumbs={[{ label: "Lyra", onClick: toWs }, { label: "Board" }]}
        title="Board"
        actions={<button type="button">New card</button>}
      />,
    );
    const nav = screen.getByRole("navigation", { name: "Breadcrumb" });
    await r.user.click(within(nav).getByRole("button", { name: "Lyra" }));
    expect(toWs).toHaveBeenCalledOnce();
    expect(within(nav).queryByRole("button", { name: "Board" })).toBeNull();
    expect(within(nav).getByText("Board").getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("heading", { level: 1, name: "Board" })).toBeTruthy();
  });

  // 1.174.0 E3: a page below the last crumb (Terminals › Copies) — that crumb
  // leads back, with its ›, and nothing is marked the current page.
  it("links a parent last crumb", async () => {
    const back = vi.fn();
    const r = renderUi(
      <ScreenHeader crumbs={[{ label: "Lyra" }, { label: "Terminals", onClick: back, parent: true }]} title="Copies" />,
    );
    const nav = screen.getByRole("navigation", { name: "Breadcrumb" });
    await r.user.click(within(nav).getByRole("button", { name: "Terminals" }));
    expect(back).toHaveBeenCalledOnce();
    expect(nav.querySelector("[aria-current]")).toBeNull();
    expect(nav.querySelectorAll(".ux-crumb svg, .ux-crumb [data-icon]").length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { level: 1, name: "Copies" })).toBeTruthy();
  });
});

describe("Properties", () => {
  it("pairs each label with its value", () => {
    renderUi(<Properties items={[{ label: "Builder", value: "Claude" }, { icon: "blockedBy", label: "Blocked by", value: "#41" }]} />);
    const terms = screen.getAllByRole("term").map((t) => t.textContent);
    const defs = screen.getAllByRole("definition").map((d) => d.textContent);
    expect(terms).toEqual(["Builder", "Blocked by"]);
    expect(defs).toEqual(["Claude", "#41"]);
  });
});

describe("Callout", () => {
  it("announces a warning and draws the now state as a dot", () => {
    const r = renderUi(
      <div>
        <Callout kind="warn" title="Checks failed" text="2 of 14 tests failed." />
        <Callout kind="now" state="running" live title="Claude is building" />
      </div>,
    );
    expect(screen.getByRole("alert").textContent).toContain("Checks failed");
    const dot = r.container.querySelector(".ux-callout--now .ux-state-dot");
    expect(dot?.className).toBe("ux-state-dot ux-state-dot--running ux-state-dot--live");
  });
});

describe("Timeline", () => {
  it("lists events in order and runs a link", async () => {
    const open = vi.fn();
    const r = renderUi(
      <Timeline
        events={[
          { id: "a", state: "done", text: "Planned with Claude", when: "09:20" },
          { id: "b", state: "running", live: true, text: "Claude is fixing the tests", when: "now", link: { label: "Open session", onClick: open } },
        ]}
      />,
    );
    const items = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(items[0]).toContain("Planned with Claude");
    expect(items[1]).toContain("Claude is fixing the tests");
    await r.user.click(screen.getByRole("button", { name: "Open session" }));
    expect(open).toHaveBeenCalledOnce();
  });
});

describe("Popover", () => {
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <Popover
        label="Workspaces"
        open={open}
        onClose={() => setOpen(false)}
        trigger={<button type="button" onClick={() => setOpen((o) => !o)}>Lyra</button>}
      >
        <p>atelier</p>
      </Popover>
    );
  }
  it("opens under its trigger and closes on Escape", async () => {
    const r = renderUi(<Harness />);
    await r.user.click(screen.getByRole("button", { name: "Lyra" }));
    expect(screen.getByRole("dialog", { name: "Workspaces" })).toBeTruthy();
    await r.user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Workspaces" })).toBeNull();
  });
});

describe("ListView", () => {
  type Row = { id: string; title: string; status: string };
  const rows: Row[] = [
    { id: "1", title: "Fix login redirect", status: "Ready to ship" },
    { id: "2", title: "Rate-limit search", status: "Checks failed" },
  ];
  function Harness() {
    const [sort, setSort] = useState<ListSort>({ key: "title", dir: "asc" });
    const [sel, setSel] = useState<Set<string>>(new Set());
    const sorted = [...rows].sort((a, b) =>
      sort.dir === "asc" ? a.title.localeCompare(b.title) : b.title.localeCompare(a.title),
    );
    return (
      <ListView<Row>
        label="Cards"
        columns={[
          { key: "title", label: "Title", primary: true, sortable: true, cell: (r) => r.title },
          { key: "status", label: "Status", cell: (r) => r.status },
        ]}
        groups={[{ key: "needs", label: "Needs you", rows: sorted }]}
        sort={sort}
        onSort={setSort}
        selected={sel}
        onSelect={(id, on) => setSel((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; })}
      />
    );
  }
  it("sorts, groups with a count and selects", async () => {
    const r = renderUi(<Harness />);
    const table = screen.getByRole("table", { name: "Cards" });
    expect(within(table).getByText("Needs you · 2")).toBeTruthy();
    const titles = () => Array.from(table.querySelectorAll(".ux-list-td--primary")).map((c) => c.textContent);
    expect(titles()).toEqual(["Fix login redirect", "Rate-limit search"]);
    await r.user.click(within(table).getByRole("button", { name: "Title" }));
    expect(titles()).toEqual(["Rate-limit search", "Fix login redirect"]);
    const boxes = within(table).getAllByRole("checkbox", { name: "Select row" });
    await r.user.click(boxes[0]);
    expect(table.querySelectorAll(".ux-list-row--selected")).toHaveLength(1);
  });
});
