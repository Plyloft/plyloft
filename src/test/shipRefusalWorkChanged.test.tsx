// Immediacy walk 8.3 (Mac, 2026-11-10): Ship it (here) was refused over a
// file in the project folder in the way of the card's merge (`atMerge`).
// After an approved Finish and check the card still said "Ship didn't go
// through": the refusal was about the old work. A Finish and check that
// records a new snapshot is new work, and the old refusal comes off.
import { describe, expect, it, vi } from "vitest";
import { shipRefusedFor } from "../lib/shipRefusal";
import { useBuilder } from "../store/builderStore";
import { observeShipAttempt, useErrorBlocks } from "../store/errorBlockStore";
import { BOARD_WS, boardCard, seedBoard } from "./boardFixtures";
import { act, tauri } from "./render";

const refusedAtMerge = {
  operation: "land",
  atMerge: true,
  localBranch: {
    branch: "main",
    outcome: {
      kind: "untrackedDiffers",
      behind: 0,
      from: "a",
      to: "b",
      paths: ["notes.txt"],
      items: [{ kind: "file", name: "notes.txt", paths: ["notes.txt"], directory: false }],
      output: "error: The following untracked working tree files would be overwritten by merge:\n\tnotes.txt\nAborting",
      repeated: false,
    },
  },
};

async function finishAndCheck(newSnapshot: boolean) {
  seedBoard([boardCard("c1")]);
  const stub = tauri();
  stub.allowUnhandled();
  stub.fixture("builder_done", () => ({
    snapshot: { n: 2, sha: "s2", at: 10 },
    newSnapshot,
    reselected: false,
    reviewOverridden: false,
    changesRequested: false,
    snapshotVerified: false,
    reviewWaitingOn: null,
  }));
  stub.fixture("kanban_load", () => [boardCard("c1")]);
  stub.fixture("verify_start", () => "verify-1");
  stub.fixture("project_config_get", () => ({ targetBranch: "main", versionFiles: [], verifyPipeline: null, installScript: null }));
  const inject = vi.spyOn(useBuilder.getState(), "inject").mockImplementation(() => {});
  await act(async () => {
    await useBuilder.getState().done(BOARD_WS, "c1");
  });
  inject.mockRestore();
}

describe("a new snapshot takes a merge's old refusal off (walk 8.3)", () => {
  it("a Finish and check that records nothing new leaves it; one that records a snapshot clears it", async () => {
    act(() => {
      observeShipAttempt(BOARD_WS, ["c1"], "ship", { refused: refusedAtMerge });
    });
    expect(shipRefusedFor(useErrorBlocks.getState().byWorkspace, BOARD_WS, "c1")).toBe(true);
    await finishAndCheck(false);
    expect(shipRefusedFor(useErrorBlocks.getState().byWorkspace, BOARD_WS, "c1")).toBe(true);
    await finishAndCheck(true);
    expect(shipRefusedFor(useErrorBlocks.getState().byWorkspace, BOARD_WS, "c1")).toBe(false);
  });
});
