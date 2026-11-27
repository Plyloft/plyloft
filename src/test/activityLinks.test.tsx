// 1.174.0 C5 round 1 (P43, T45): Activity's links land where they say — a
// skipped review's "Why it was skipped" on the line that says why, even once
// its pull request is open, and a merged pull request's "See the pull
// request" on GitHub.
import { describe, expect, it } from "vitest";
import { CardDetailPanel } from "../components/CardDetailPanel";
import type { KanbanCard, PrStatus } from "../ipc";
import { useUi } from "../store/uiStore";
import { BOARD_WS, boardCard, seedBoard } from "./boardFixtures";
import { act, fireEvent, renderUi, screen, waitFor } from "./render";

const URL = "https://github.com/o/r/pull/138";

const pr = (patch: Partial<PrStatus> = {}): PrStatus => ({
  number: 138,
  state: "open",
  checks: "passing",
  checksTotal: 2,
  checksPassed: 2,
  checksPending: 0,
  failingChecks: [],
  mergeable: "mergeable",
  reviewDecision: "none",
  openedAt: Date.now() - 60_000,
  checkedAt: Date.now(),
  ...patch,
});

const skippedBuilder = {
  vendor: "codex",
  bypass: false,
  ptyId: null,
  sessionLost: false,
  startedAt: Date.now() - 20 * 60_000,
  snapshots: [{ n: 1, sha: "abc", at: Date.now() - 10 * 60_000 }],
  review: { snapshotN: 1, provider: "claude", degraded: false, status: "skipped", at: Date.now() - 9 * 60_000 },
} as unknown as KanbanCard["builder"];

function openCard(card: KanbanCard) {
  act(() => {
    seedBoard([card]);
    useUi.setState({ selectedCardId: { [BOARD_WS]: card.id }, centerMode: { [BOARD_WS]: "board" } });
  });
  const view = renderUi(<CardDetailPanel workspaceId={BOARD_WS} />, {
    fixtures: { open_web_link: null, kanban_load: [card] },
  });
  view.tauri.allowUnhandled();
  return view;
}

describe("Activity's links", () => {
  it("Why it was skipped, with the pull request open, lands on the line that says why", async () => {
    openCard(
      boardCard("c-skip", {
        title: "Site: say hello",
        columnId: "complete",
        reviewStatus: "merged",
        verifyStatus: "passed",
        lastRunStatus: "success",
        worktreePath: "/Users/someone/lyra/.plyloft-worktrees/card-1",
        branchName: "atelier/card-1",
        prUrl: URL,
        pr: pr(),
        builder: skippedBuilder,
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Why it was skipped" }));
    await waitFor(() => {
      const why = document.querySelector<HTMLElement>("[data-ply-review-part='skipped']");
      expect(why?.textContent).toBe("You skipped the review of the latest build.");
      expect(document.activeElement).toBe(why);
    });
  });

  it("See the pull request on a merged pull request opens it on GitHub", async () => {
    const view = openCard(
      boardCard("c-merged", {
        title: "Site: say hello",
        columnId: "complete",
        reviewStatus: "merged",
        shipStatus: "shipped",
        verifyStatus: "passed",
        prUrl: URL,
        pr: pr({ state: "merged", mergeCommit: "m1", mergedAt: Date.now() - 30_000 }),
        shipHistory: [{ commitSha: "m1", shippedAt: Date.now() - 30_000 }] as never,
        builder: skippedBuilder,
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "See the pull request" }));
    await waitFor(() => expect(view.tauri.callsOf("open_web_link")).toHaveLength(1));
    expect(view.tauri.callsOf("open_web_link")[0].args).toMatchObject({ url: URL });
  });

  // C5 round 2: a ship on this computer — its pull request closed — shows
  // what shipped, never GitHub.
  it("See what shipped on a card with a closed pull request shows what shipped", async () => {
    const view = openCard(
      boardCard("c-local", {
        title: "Site: say hello",
        columnId: "complete",
        reviewStatus: "merged",
        shipStatus: "shipped",
        verifyStatus: "passed",
        prUrl: URL,
        pr: pr({ state: "closed", closedAt: Date.now() - 60_000 }),
        shipHistory: [{ commitSha: "l1", shippedAt: Date.now() - 30_000, version: "v1.2.0" }] as never,
        builder: skippedBuilder,
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "See what shipped" }));
    await waitFor(() => expect(document.querySelector("[data-ply-shipped-result]")).toBeTruthy());
    expect(view.tauri.callsOf("open_web_link")).toHaveLength(0);
  });
});
