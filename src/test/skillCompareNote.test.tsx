// Walk follow-ups 2026-10-19: a duplicate's Compare shows this checkout's
// working copy; when Promote (Replace, Complete) in Team shares the copy
// committed on the branch instead, the side says "this checkout's copy" and
// the row's note says which copy the button shares.
import { describe, expect, it } from "vitest";
import { SkillCompare } from "../components/library/SkillCompare";
import { COMPARE_CHECKOUT_SIDE } from "../lib/librarySkills";
import { renderUi, screen } from "./render";

const NOTE =
  "This checkout's `mine` has changes not on walk-1014. Replace in Team shares the copy committed on walk-1014; your local changes aren't included.";

function draw(note: string | null) {
  return renderUi(
    <SkillCompare
      name="mine"
      left={{ label: "Repository", meaning: note ? COMPARE_CHECKOUT_SIDE : "in use here", place: "in this repository", text: "# mine\nlocal\n" }}
      right={{ label: "Team", meaning: "every team workspace", place: "in the team library", text: "# mine\nteam\n" }}
      error={null}
      actions={[
        { id: "keep-both", label: "Keep both" },
        { id: "promote-to-team", label: "Replace in Team…", confirm: true },
      ]}
      busy={false}
      onAction={() => {}}
      onHide={() => {}}
      note={note}
    />,
  );
}

describe("Compare says which copy Replace shares", () => {
  it("names the checkout's side and says the branch's copy goes", () => {
    const { container } = draw(NOTE);
    expect(container.textContent).toContain("Repository · your project folder's copy");
    expect(container.textContent).toContain("Replace in Team shares the copy committed on walk-1014");
    // The note's `code` is drawn, not shown as backticks.
    expect(container.textContent).not.toContain("`mine`");
    expect(screen.getByRole("button", { name: "Replace in Team…" })).toBeTruthy();
  });

  it("says nothing more when the copy shown is the one shared", () => {
    const { container } = draw(null);
    expect(container.textContent).toContain("Repository · in use here");
    expect(container.textContent).not.toContain("shares the copy");
  });
});
