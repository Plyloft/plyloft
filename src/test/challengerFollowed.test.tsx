// CL-2: the skills the Challenger followed are neutral chips under its
// verdict — stored on new reviews, read from the excerpt on older ones —
// with what each skill asked behind Details.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ChallengerFindings } from "../components/ChallengerFindings";
import type { BuilderReview, KanbanCard } from "../ipc";
import { renderUi, screen } from "./render";

const card: KanbanCard = {
  id: "card-1",
  workspaceId: "ws-1",
  title: "Deploy skill",
  columnId: "complete",
  createdAt: 1,
  updatedAt: 1,
};

const review = (extra: Partial<BuilderReview>): BuilderReview => ({
  snapshotN: 1,
  provider: "codex",
  degraded: false,
  status: "done",
  verdict: "approve",
  at: 1,
  ...extra,
});

describe("Followed chips (CL-2)", () => {
  it("shows the stored skills as neutral chips, the notes behind Details", () => {
    const { container } = renderUi(
      <ChallengerFindings
        card={card}
        review={review({ skillsFollowed: [{ skill: "review-rules", note: "RR-OK-5521" }, { skill: "house-style", note: "" }] })}
      />,
    );
    const chips = [...container.querySelectorAll("[data-ply-followed] .cchip")];
    expect(chips.map((c) => c.textContent)).toEqual(["review-rules", "house-style"]);
    for (const chip of chips) {
      expect(chip.className).toBe("cchip cchip--outline");
    }
    expect(screen.getByText("Followed")).toBeTruthy();
    const details = container.querySelector("[data-ply-followed] details")!;
    expect(details.hasAttribute("open")).toBe(false);
    expect(details.textContent).toContain("What the skill asked");
    expect(details.textContent).toContain("RR-OK-5521");
  });

  it("reads an older review's Followed line from its excerpt", () => {
    const { container } = renderUi(
      <ChallengerFindings card={card} review={review({ excerpt: "## Verdict\nAPPROVE\nFollowed: review-rules\n" })} />,
    );
    expect([...container.querySelectorAll("[data-ply-followed] .cchip")].map((c) => c.textContent)).toEqual([
      "review-rules",
    ]);
    expect(container.querySelector("[data-ply-followed] details")).toBeNull();
  });

  it("draws nothing when no skill was followed", () => {
    const { container } = renderUi(<ChallengerFindings card={card} review={review({ excerpt: "## Verdict\nAPPROVE\n" })} />);
    expect(container.querySelector("[data-ply-followed]")).toBeNull();
  });

  it("keeps the chips' rules free of run-state colours", () => {
    const css = readFileSync("src/components/ux/ux.css", "utf8");
    const block = css.slice(css.indexOf("/* CL-2:"), css.indexOf(".ux-card-followed-notes dd"));
    expect(block).not.toMatch(/--signal-|--ok|--warn|--danger/);
  });
});
