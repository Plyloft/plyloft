// 1.176.2 F6: visual consistency. jsdom lays nothing out, so these assert the
// structure and the rules the stylesheets draw from; pixels are for the walk.
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { CBtn, Group, MoreMenu, Row, Section } from "../components/ux";
import { TidyColumns } from "../components/ux/Page";
import { createTidyShare } from "../components/ux/useTidyTable";
import { shortModelHint } from "../lib/diagnostics";
import { renderUi } from "./render";

const css = (p: string) => readFileSync(`${process.cwd()}/src/${p}`, "utf8");
const undo: (() => void)[] = [];
afterEach(() => {
  while (undo.length) undo.pop()!();
});
/** Cells measure by their text length, as a real web view would. */
function stubWidths(content = 1000) {
  const rect = HTMLElement.prototype.getBoundingClientRect;
  const client = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => content });
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const w = this.textContent ? this.textContent.length * 10 : 1;
    return { width: w, height: 30, top: 0, left: 0, right: w, bottom: 30, x: 0, y: 0, toJSON() {} } as DOMRect;
  };
  undo.push(() => {
    HTMLElement.prototype.getBoundingClientRect = rect;
    if (client) Object.defineProperty(HTMLElement.prototype, "clientWidth", client);
    else delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
  });
}

// Items 1 (check-row note wraps whole), 2 (the board ring) and the chapter
// label's inset of 5 are layout and paint: jsdom lays nothing out, so no
// meaningful structural assertion exists. They are checked in the walk only.
// The one thing a test can hold is M3's side effect: an empty column body
// keeps its old height, border-box padding included.
describe("F6 item 2: board column body keeps its empty height", () => {
  it("adds the ring's room to the old minimum height", () => {
    const board = css("components/board.css");
    const i = board.indexOf("\n.board-column-body {");
    expect(board.slice(i, board.indexOf("}", i))).toMatch(
      /min-height:\s*calc\(var\(--row-comfortable\) \+ 2 \* var\(--space-xs\)\)/,
    );
  });
});

describe("F6 item 3: the tables of a section share one action column, not the ⋯ slot", () => {
  it("the share holds the widest action", () => {
    const s = createTidyShare();
    const a = {};
    const b = {};
    s.report(a, 100);
    s.report(b, 180);
    expect(s.read()).toEqual({ action: 180 });
    s.forget(b);
    expect(s.read()).toEqual({ action: 100 });
  });

  it("two Groups in TidyColumns take the wider button; the ⋯ slot stays the table's own", () => {
    stubWidths();
    const r = renderUi(
      <TidyColumns>
        <Group label="Narrow">
          <Row kind="procedure" label="One" action={<CBtn>Manage</CBtn>} />
        </Group>
        <Group label="Wide">
          <Row kind="procedure" label="Two" action={<CBtn>Sign out other computers</CBtn>} more={<MoreMenu label="More" items={[{ label: "x", onSelect: () => {} }]} />} />
        </Group>
      </TidyColumns>,
    );
    const [narrow, wide] = Array.from(r.container.querySelectorAll<HTMLElement>(".ux-group"));
    expect(narrow.style.getPropertyValue("--ux-action-w")).toBe(wide.style.getPropertyValue("--ux-action-w"));
    // 1.176.3 (Shipping's G1 walk): Releases keeps no slot for a chevron elsewhere.
    expect(narrow.getAttribute("data-has-more")).toBeNull();
    expect(wide.getAttribute("data-has-more")).toBe("true");
  });

  it("a Section's select-only table gets no ⋯ slot from the chevron table beside it", () => {
    stubWidths();
    const r = renderUi(
      <Section title="Releases">
        <Group label="Menus">
          <Row kind="procedure" label="One" action={<CBtn>Release…</CBtn>} />
        </Group>
        <Group label="Files">
          <Row kind="procedure" label="Version files" action={<CBtn>Open</CBtn>} more={<MoreMenu label="More" items={[{ label: "x", onSelect: () => {} }]} />} />
        </Group>
      </Section>,
    );
    const menus = r.container.querySelector<HTMLElement>('.ux-group[aria-label="Menus"]')!;
    expect(menus.getAttribute("data-has-more")).toBeNull();
    expect(menus.classList.contains("ux-table--stacked")).toBe(false);
  });

  it("without TidyColumns each Group keeps its own", () => {
    stubWidths();
    const r = renderUi(
      <>
        <Group label="Narrow">
          <Row kind="procedure" label="One" action={<CBtn>Manage</CBtn>} />
        </Group>
        <Group label="Wide">
          <Row kind="procedure" label="Two" action={<CBtn>Sign out other computers</CBtn>} />
        </Group>
      </>,
    );
    const [narrow, wide] = Array.from(r.container.querySelectorAll<HTMLElement>(".ux-group"));
    expect(narrow.style.getPropertyValue("--ux-action-w")).not.toBe(wide.style.getPropertyValue("--ux-action-w"));
  });
});

describe("1.176.3: the tables of one section share their buttons, not those of the page", () => {
  it("two Sections each keep their own width; two Groups of one Section share", () => {
    stubWidths();
    const r = renderUi(
      <>
        <Section title="Plan">
          <Group label="A">
            <Row kind="procedure" label="One" action={<CBtn>Sign out</CBtn>} />
          </Group>
          <Group label="B">
            <Row kind="procedure" label="Two" action={<CBtn>Check for updates now</CBtn>} />
          </Group>
        </Section>
        <Section title="Device">
          <Group label="C">
            <Row kind="procedure" label="Three" action={<CBtn>Sign out</CBtn>} />
          </Group>
        </Section>
      </>,
    );
    const w = (l: string) =>
      r.container.querySelector<HTMLElement>(`.ux-group[aria-label="${l}"]`)!.style.getPropertyValue("--ux-action-w");
    expect(w("A")).toBe(w("B"));
    expect(w("C")).not.toBe(w("A"));
  });
});

describe("F6 item 6: the Dictation model row", () => {
  it("says what is missing, not the path to the button beside it", () => {
    expect(
      shortModelHint("Not downloaded — Settings › Look and feel › Dictation › The model file › Download (~466 MB)."),
    ).toBe("Not downloaded (~466 MB).");
  });
});

describe("F6 sheets: a sheet opened from a shared-column page keeps its own tables", () => {
  it("a Group inside a Sheet does not report into the page's share", async () => {
    const { Sheet } = await import("../components/ux");
    stubWidths();
    const r = renderUi(
      <TidyColumns>
        <Group label="Page">
          <Row kind="procedure" label="One" action={<CBtn>Manage</CBtn>} />
        </Group>
        <Sheet title="Inside" onClose={() => {}}>
          <Group label="Sheet">
            <Row kind="procedure" label="Two" action={<CBtn>Sign out other computers</CBtn>} />
          </Group>
        </Sheet>
      </TidyColumns>,
    );
    const page = r.container.querySelector<HTMLElement>('.ux-group[aria-label="Page"]')!;
    const inSheet = document.querySelector<HTMLElement>('.ux-group[aria-label="Sheet"]')!;
    expect(page.style.getPropertyValue("--ux-action-w")).not.toBe(inSheet.style.getPropertyValue("--ux-action-w"));
  });
});
