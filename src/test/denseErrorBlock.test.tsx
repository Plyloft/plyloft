// GH #150: the error block at the card's density. The card is a work surface
// (PRINCIPLES.md §4), so every error block drawn on it is `ux-error--dense`,
// and a page's stays the page's.
//
//  1. A failing Verify on the card — the real `VerifyPanel`, reading the run
//     from `verify_status` the way the card does — draws the dense block, with
//     the title, the three parts, and `Open full log` under `Details`.
//  2. A timed-out run's `What the steps reported` is drawn dense too.
//  3. The Ship step's refusal (#151) is dense on the card; the very same
//     refusal on the Library page keeps the page density.
//
// Red when `density="dense"` is dropped from `VerifyFailureBlock`, from the
// Ship step's `LocalBranchBlock`, or the class from `VerifyStepOutput`.
import { describe, expect, it } from "vitest";
import { VerifyPanel } from "../components/VerifyPanel";
import { LocalBranchBlock } from "../components/errors/LocalBranchBlock";
import type { KanbanCard, VerifyJobStatus } from "../ipc";
import { useErrorBlocks } from "../store/errorBlockStore";
import { renderUi, screen, within } from "./render";

const WS = "ws-1";
const SKILL = ".claude/skills/deploy/SKILL.md";

const card: KanbanCard = {
  id: "card-1",
  workspaceId: WS,
  title: "Deploy skill",
  columnId: "complete",
  verifyStatus: "failed",
  worktreePath: "/tmp/ply-test/card-1",
  branchName: "card/card-1",
  createdAt: 1,
  updatedAt: 1,
};

function run(state: VerifyJobStatus["state"]): VerifyJobStatus {
  return {
    verifyRunId: "run-1",
    workspaceId: WS,
    cardId: card.id,
    state,
    steps: [
      { kind: "ppvp-sh", passed: false, elapsedMs: 1200, reason: "FAIL src/a.test.ts\n1 failed" },
    ],
  };
}

function renderVerify(status: VerifyJobStatus) {
  return renderUi(<VerifyPanel card={card} />, {
    fixtures: {
      verify_status: status,
      verify_inflight: [],
      verify_reveal_log: null,
    },
  });
}

/** The block a title belongs to: the `group` it labels. */
async function blockTitled(title: string) {
  return screen.findByRole("group", { name: title });
}

describe("the card's Verify failure", () => {
  it("is the dense block, with its three parts and the full log", async () => {
    const { user, tauri } = renderVerify(run({ kind: "failed", reason: "ppvp-sh failed" }));
    const block = await blockTitled("Your checks didn't pass.");
    expect(block.classList.contains("ux-error")).toBe(true);
    expect(block.classList.contains("ux-error--dense")).toBe(true);
    const inside = within(block);
    for (const part of ["What happened", "What was left untouched", "What to do"]) {
      expect(inside.getByText(part)).toBeTruthy();
    }
    // Details, closed by default, holds the output and the log.
    await user.click(inside.getByText("Details"));
    expect(inside.getByText(/1 failed/)).toBeTruthy();
    await user.click(inside.getByRole("button", { name: "Open full log" }));
    expect(tauri.callsOf("verify_reveal_log")).toHaveLength(1);
  });

  it("a timed-out run's step output is drawn at the card's density too", async () => {
    renderVerify(run({ kind: "timedOut", step: "ppvp-sh" }));
    const summary = await screen.findByText("What the steps reported");
    const wrap = summary.closest(".ux-error-details");
    expect(wrap?.classList.contains("ux-error-details--dense")).toBe(true);
    // Not a failure: no block, and no dense block borrowed for it.
    expect(screen.queryByRole("group", { name: "Your checks didn't pass." })).toBeNull();
  });
});

describe("the Ship step's refusal (#151)", () => {
  function seed() {
    useErrorBlocks.setState({
      byWorkspace: {
        [WS]: {
          localBranch: {
            branch: "staging",
            paths: [SKILL],
            items: [{ kind: "skill", name: "deploy", paths: [SKILL], directory: false }],
            output: `error: Untracked working tree file '${SKILL}' would be overwritten by merge.`,
            trashError: null,
            stuckInTrash: [],
          },
          shipStep: { cardIds: [card.id], stopped: "ship" },
          publishRefused: null,
          unpublished: null,
          unreadableRecord: null,
          localState: null,
        },
      },
    });
  }

  it("is dense on the card", async () => {
    seed();
    renderUi(<LocalBranchBlock workspaceId={WS} on="card-ship" cardId={card.id} />);
    const block = await blockTitled("Ship stopped: local staging can't be updated.");
    expect(block.classList.contains("ux-error--dense")).toBe(true);
    expect(within(block).getAllByRole("button").length).toBeGreaterThanOrEqual(2);
  });

  it("keeps the page density on the Library", async () => {
    seed();
    renderUi(<LocalBranchBlock workspaceId={WS} on="library" />);
    const block = await blockTitled("Local staging can't be updated.");
    expect(block.classList.contains("ux-error")).toBe(true);
    expect(block.classList.contains("ux-error--dense")).toBe(false);
  });
});
