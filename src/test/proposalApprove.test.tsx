// SP-5: a solo user approves too. The block's button says what it does: a
// repository with no remote gets `Approve and commit to <branch>` and a line
// that nothing is pushed; one that publishes keeps `Approve and publish`.
import { describe, expect, it } from "vitest";
import { ProposalBlock } from "../components/library/ProposalBlock";
import type { ProposalView } from "../lib/proposals";
import { renderUi, screen } from "./render";

const DIFF = [
  "--- a/AGENTS.md",
  "+++ b/AGENTS.md",
  "@@ -1,2 +1,3 @@",
  " # Project",
  "+Run the tests before reporting done.",
  " Rules.",
].join("\n");

function view(over: Partial<ProposalView>): ProposalView {
  return {
    target: { kind: "instructions", file: "AGENTS.md" },
    label: "AGENTS.md",
    scope: "repository",
    path: "AGENTS.md",
    cardId: "c-1",
    cardRef: "#88",
    reason: "The Builder reported done twice before running the tests.",
    words: "Add one line: run the tests before saying done.",
    diff: DIFF,
    createdAt: Date.now() - 3600_000,
    canApprove: true,
    ...over,
  };
}

function draw(v: ProposalView) {
  return renderUi(
    <ProposalBlock view={v} busy={false} onApprove={() => {}} onDismiss={() => {}} nowMs={Date.now()} />,
  );
}

describe("SP-5: the Approve button names where the change goes", () => {
  it("says `Approve and commit to main` without a remote, and that nothing is pushed", () => {
    draw(view({ commitTo: "main" }));
    expect(screen.getByRole("button", { name: "Approve and commit to main" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve and publish" })).toBeNull();
    expect(document.querySelector(".ux-proposal-beside")?.textContent).toBe(
      "A commit on main in this repository. It isn't connected to GitHub, so nothing is pushed.",
    );
  });

  it("keeps `Approve and publish` when the change is published", () => {
    draw(view({ commitTo: null }));
    expect(screen.getByRole("button", { name: "Approve and publish" })).toBeTruthy();
    expect(document.querySelector(".ux-proposal-beside")?.textContent).toBe(
      "Publishing reaches everyone who opens this repository.",
    );
  });

  it("says why in place of the button when the commit can't be made", () => {
    const why =
      "AGENTS.md isn't on main yet. Commit it to main first, then approve.";
    draw(view({ canApprove: false, commitTo: "main", approveBlocked: why }));
    expect(screen.queryByRole("button", { name: /^Approve/ })).toBeNull();
    expect(document.querySelector("[data-ply-proposal-blocked]")?.textContent).toBe(why);
  });

  it("says before the press that the skill's other copy changes too, or doesn't", () => {
    const same = "Codex's copy (.agents/skills/deploy) is the same file, so it changes too.";
    draw(view({ copiesNote: same }));
    expect(document.querySelector("[data-ply-proposal-copies]")?.textContent).toBe(same);
  });

  it("says nothing about copies when Approve is not offered", () => {
    draw(view({ canApprove: false, copiesNote: "Codex's copy … changes too." }));
    expect(document.querySelector("[data-ply-proposal-copies]")).toBeNull();
  });

  it("offers neither to a collaborator who cannot approve", () => {
    draw(view({ canApprove: false, commitTo: "main" }));
    expect(screen.queryByRole("button", { name: /^Approve/ })).toBeNull();
  });
});
