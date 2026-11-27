// ADR 0007 §2 (SP-1 walk fix): the run history's collision badge draws the
// map's warning icon, never the ⚠ text glyph.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { RunHistoryAccordion } from "../components/KanbanRunHistory";
import type { RunHistoryEntry } from "../ipc";
import { renderUi } from "./render";

const entry: RunHistoryEntry = {
  runId: "run-1",
  status: "done",
  endedAt: Date.now(),
  filesChangedCount: 2,
  topPaths: ["src/a.ts"],
  swarmCollisions: 3,
};

describe("the run history's collision badge", () => {
  it("is the warning Icon beside the count", () => {
    const { container } = renderUi(<RunHistoryAccordion entries={[entry]} onClear={() => {}} />);
    const badge = container.querySelector(".kanban-history-collision")!;
    expect(badge.querySelector("svg.ux-icon")).not.toBeNull();
    expect(badge.textContent?.trim()).toBe("3");
  });

  it("holds no ⚠ in the source", () => {
    const src = readFileSync("src/components/KanbanRunHistory.tsx", "utf8").replace(
      /\/\*[\s\S]*?\*\/|\/\/.*$/gm,
      "",
    );
    expect(src).not.toMatch(/⚠/);
  });
});
