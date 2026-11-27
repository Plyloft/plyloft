// Owner, 2026-10-20: in every Compare a line that exists on one side only shows
// its `+` on that side and a neutral blank on the other — never a `−`
// `(nothing here)` row styled as a deletion opposite a pure addition (and the
// same for a pure removal). The blank stays out of the reading; the side with
// the text keeps its "only here".
import { describe, expect, it } from "vitest";
import { SkillCompare } from "../components/library/SkillCompare";
import { renderUi } from "./render";

function draw(leftText: string, rightText: string) {
  return renderUi(
    <SkillCompare
      name="deploy"
      left={{ label: "Repository", meaning: "in use here", place: "in this repository", text: leftText }}
      right={{ label: "Team", meaning: "every team workspace", place: "in the team library", text: rightText }}
      error={null}
      actions={[{ id: "keep-both", label: "Keep both" }]}
      busy={false}
      onAction={() => {}}
      onHide={() => {}}
    />,
  );
}

/** Each column's rows, in order. */
function columns(container: HTMLElement): HTMLElement[][] {
  return Array.from(container.querySelectorAll<HTMLElement>(".ux-compare-side")).map((side) =>
    Array.from(side.querySelectorAll<HTMLElement>(".ux-compare-line")),
  );
}

function expectBlank(row: HTMLElement) {
  expect(row.className).toContain("ux-compare-line--blank");
  expect(row.className).not.toContain("ux-compare-line--diff");
  expect(row.getAttribute("aria-hidden")).toBe("true");
  expect(row.textContent?.trim()).toBe("");
  expect(row.querySelector('[role="img"]')).toBeNull();
}

function expectOnlyHere(row: HTMLElement, text: string) {
  expect(row.className).toContain("ux-compare-line--diff");
  expect(row.getAttribute("aria-hidden")).toBeNull();
  const mark = row.querySelector('[role="img"]');
  expect(mark?.textContent).toBe("+");
  expect(mark?.getAttribute("aria-label")).toBe("only here");
  expect(row.querySelector(".ux-compare-text")?.textContent).toBe(text);
}

describe("Compare: a one-sided line is blank on the other side", () => {
  it("draws a pure addition as + here and a neutral blank there", () => {
    const { container } = draw("a\nadded\n", "a\n");
    const [left, right] = columns(container);
    expect(left).toHaveLength(2);
    expect(right).toHaveLength(2);
    expectOnlyHere(left[1], "added");
    expectBlank(right[1]);
    expect(container.textContent).not.toContain("nothing here");
    expect(container.textContent).not.toContain("−");
    expect(container.querySelector('[aria-label="nothing here"]')).toBeNull();
  });

  it("draws a pure removal the same way, mirrored", () => {
    const { container } = draw("a\n", "a\nonly there\n");
    const [left, right] = columns(container);
    expectBlank(left[1]);
    expectOnlyHere(right[1], "only there");
    expect(container.textContent).not.toContain("nothing here");
  });

  it("draws a changed line as ≠ on both sides, both read", () => {
    const { container } = draw("a\nold\n", "a\nnew\n");
    const [left, right] = columns(container);
    for (const [row, text] of [
      [left[1], "old"],
      [right[1], "new"],
    ] as const) {
      expect(row.className).toContain("ux-compare-line--diff");
      expect(row.className).not.toContain("ux-compare-line--blank");
      const mark = row.querySelector('[role="img"]');
      expect(mark?.textContent).toBe("≠");
      expect(mark?.getAttribute("aria-label")).toBe("changed");
      expect(row.querySelector(".ux-compare-text")?.textContent).toBe(text);
    }
    // An identical line is plain on both sides.
    expect(left[0].className).toBe("ux-compare-line");
    expect(right[0].className).toBe("ux-compare-line");
  });

  it("counts only the lines a side has in its heading", () => {
    const { container } = draw("a\nb\nc\n", "a\n");
    const heads = Array.from(container.querySelectorAll(".ux-compare-head")).map((h) => h.textContent);
    expect(heads[0]).toContain("3 lines");
    expect(heads[1]).toContain("1 line");
  });
});
