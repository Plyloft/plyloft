// GH #274: the shared controls draw Lucide icons through `Icon`, never the
// text glyphs they once did (⋯ ⌕ ✕ ▾ ▸ ←). A glyph sits at text size, thin and
// font-dependent; the icon is the one set at the one scale (ADR 0007).
import { describe, expect, it } from "vitest";
import {
  BackLink,
  Details,
  MoreMenu,
  SearchField,
  Select,
  TypeOrChoose,
} from "../components/ux";
import { renderUi, screen } from "./render";

const GLYPHS = /[⋯⌕✕×▾▴▸◂←]/;

describe("the shared controls' icons", () => {
  it("draw no text glyph, only Lucide icons", () => {
    const r = renderUi(
      <div>
        <MoreMenu items={[{ label: "Rename", onSelect: () => {} }]} />
        <SearchField value="qqqzz" onChange={() => {}} placeholder="Find a card" />
        <Select
          label="Theme"
          value="a"
          options={[{ value: "a", label: "Light" }]}
          onChange={() => {}}
        />
        <TypeOrChoose
          label="Model"
          value=""
          defaultLabel="Default"
          options={["opus"]}
          footnote="Or type one."
          onChange={() => {}}
          onCommit={() => {}}
        />
        <BackLink label="Skills" onClick={() => {}} />
        <Details>raw text</Details>
      </div>,
    );
    expect(r.container.textContent ?? "").not.toMatch(GLYPHS);
    for (const name of ["More", "Clear", "Skills"]) {
      expect(screen.getByRole("button", { name }).querySelector("svg.ux-icon")).not.toBeNull();
    }
    expect(r.container.querySelector(".ux-field-glyph svg.ux-icon")).not.toBeNull();
    expect(r.container.querySelector(".ux-field-caret svg.ux-icon")).not.toBeNull();
    expect(r.container.querySelector(".ux-choose-caret svg.ux-icon")).not.toBeNull();
    expect(r.container.querySelector(".ux-details-summary svg.ux-icon")).not.toBeNull();
  });

  it("keeps the search field out of spell check", () => {
    renderUi(<SearchField value="qqqzz" onChange={() => {}} placeholder="Find a card" />);
    expect(screen.getByRole("searchbox").getAttribute("spellcheck")).toBe("false");
  });
});
