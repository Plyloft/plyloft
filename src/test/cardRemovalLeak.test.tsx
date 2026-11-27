// The Undo window's timer belongs to its test (setup.ts). It once outlived
// "Archive leaves for the Board with Undo", wrote during "undoes a pick the
// backend refused" and its error toast replaced the one that test looked for.
import { afterEach, describe, expect, it, vi } from "vitest";
import { deferCardRemoval, resetCardRemovalsForTests, UNDO_WINDOW_MS, useBoard } from "../store/boardStore";

describe("a card removal in its Undo window", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes when the window ends", async () => {
    vi.useFakeTimers();
    const commit = vi.fn(async () => {});
    deferCardRemoval({ cardId: "c1", kind: "archive", title: "Card archived", commit });
    expect(useBoard.getState().pendingRemoval.c1).toBe("archive");
    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(useBoard.getState().pendingRemoval.c1).toBeUndefined();
  });

  it("writes nothing once the test that started it has ended", async () => {
    vi.useFakeTimers();
    const commit = vi.fn(async () => {});
    deferCardRemoval({ cardId: "c1", kind: "delete", title: "Card deleted", commit });
    resetCardRemovalsForTests();
    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS * 2);
    expect(commit).not.toHaveBeenCalled();
    // Neither its timer nor the mark that hides the card is held, so the same
    // card shows, and can be removed again.
    expect(useBoard.getState().pendingRemoval.c1).toBeUndefined();
    deferCardRemoval({ cardId: "c1", kind: "delete", title: "Card deleted", commit });
    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS);
    expect(commit).toHaveBeenCalledTimes(1);
  });
});
