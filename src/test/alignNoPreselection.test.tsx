// Owner, 2026-10-19: the Align question chooses nothing for the person. In
// both modes (a commit on the branch, a skill card) `Align` stays off until a
// copy is chosen, and the arrow keys choose one from nothing.
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AlignFlow } from "../components/library/AlignFlow";

function draw(mode: "branch" | "card") {
  const onAlign = vi.fn();
  render(
    <AlignFlow
      name="review-rules"
      branch="staging"
      mode={mode}
      lines={{ claude: 3, codex: 4 }}
      busy={false}
      onCancel={() => {}}
      onAlign={onAlign}
    />,
  );
  return { onAlign, user: userEvent.setup() };
}

const alignButton = () => screen.getByRole("button", { name: "Align" }) as HTMLButtonElement;

describe("Align: no copy chosen for the person", () => {
  for (const mode of ["branch", "card"] as const) {
    it(`${mode}: Align is off until a copy is chosen`, async () => {
      const { onAlign, user } = draw(mode);
      expect(screen.getAllByRole("radio").every((r) => r.getAttribute("aria-checked") === "false")).toBe(true);
      expect(alignButton().disabled).toBe(true);
      await user.click(alignButton());
      expect(onAlign).not.toHaveBeenCalled();
      await user.click(screen.getByRole("radio", { name: /^Claude's copy/ }));
      expect(alignButton().disabled).toBe(false);
      await user.click(alignButton());
      expect(onAlign).toHaveBeenCalledWith("claude");
    });
  }

  it("opens with focus in the question, so the first ↓ chooses the first copy (owner-fixes walk)", async () => {
    const { user } = draw("card");
    expect(document.activeElement).toBe(screen.getAllByRole("radio")[0]);
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("radio", { name: /^Claude's copy/ }).getAttribute("aria-checked")).toBe("true");
    expect(alignButton().disabled).toBe(false);
  });

  it("the arrow keys choose from nothing: down the first, up the last", async () => {
    const { user } = draw("branch");
    screen.getAllByRole("radio")[0].focus();
    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("radio", { name: /^Codex's copy/ }).getAttribute("aria-checked")).toBe("true");
  });
});
