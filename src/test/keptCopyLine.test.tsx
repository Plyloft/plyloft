// Windows walk 2026-10-20 (Try it spec §4.5): a Ship that had to keep the
// card's copy says so under Now, in plain words, with the reason behind
// Details; nothing is drawn once the copy went.
import { describe, expect, it } from "vitest";
import type { KanbanCard } from "../ipc";
import { KeptCopyLine } from "../components/KeptCopyLine";
import { setPlatformForTests } from "../lib/platform";
import { renderUi, screen } from "./render";

const card = (keptCopy: KanbanCard["keptCopy"]): KanbanCard =>
  ({ id: "c1", workspaceId: "ws", title: "T", columnId: "complete", createdAt: 1, updatedAt: 1, keptCopy }) as KanbanCard;

describe("the card's kept copy", () => {
  it("says the copy was kept on this PC, and why behind Details", () => {
    setPlatformForTests("windows");
    const reason =
      "rename to trash: The process cannot access the file because it is being used by another process. (os error 32)";
    renderUi(<KeptCopyLine card={card({ path: "C:\\r\\.plyloft-worktrees\\c1", reason, at: 1 })} />);
    expect(
      screen.getByText(
        "Plyloft kept this card's copy on this PC because a program still has it open. Plyloft removes it when you close the card's Builder session.",
      ),
    ).toBeTruthy();
    const details = screen.getByText(reason).closest("details")!;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain("C:\\r\\.plyloft-worktrees\\c1");
  });

  it("draws nothing when nothing was kept", () => {
    const { container } = renderUi(<KeptCopyLine card={card(null)} />);
    expect(container.querySelector("[data-ply-kept-copy]")).toBeNull();
  });
});
