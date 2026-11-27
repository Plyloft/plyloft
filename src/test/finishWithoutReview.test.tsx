// 1.171.0 C3 (CF18, CP-10; Challenger 2): Finish and check ▾ › Check
// without the Reviewer is one press. The card's skip is set for
// the press — `done` reads it — and is gone after it, whether the press went
// through, was refused, or was turned away as busy (`done` → null).
import { afterEach, describe, expect, it, vi } from "vitest";
import { useBuilder } from "../store/builderStore";
import { finishAndCheck } from "../store/finishAndCheck";

const realDone = useBuilder.getState().done;

function stubDone(impl: () => Promise<unknown>) {
  const seen: (boolean | undefined)[] = [];
  const done = vi.fn(async () => {
    seen.push(useBuilder.getState().skipReviewPref.c1);
    return impl();
  });
  useBuilder.setState({ done: done as never, byCard: {}, skipReviewPref: {} });
  return { done, seen };
}

afterEach(() => {
  useBuilder.setState({ done: realDone, byCard: {}, skipReviewPref: {} });
});

describe("finishAndCheck without the review", () => {
  it("went through: done saw the skip, and none is left", async () => {
    const { done, seen } = stubDone(async () => ({ snapshot: { n: 2, sha: "b", at: 1 } }));
    expect(await finishAndCheck("ws", "c1", { withoutReview: true })).toBe(true);
    expect(done).toHaveBeenCalledWith("ws", "c1");
    expect(seen).toEqual([true]);
    expect(useBuilder.getState().skipReviewPref.c1 ?? false).toBe(false);
  });

  it("refused: none is left for the next Finish and check", async () => {
    const { seen } = stubDone(async () => {
      throw new Error("The Builder's work isn't saved yet.");
    });
    expect(await finishAndCheck("ws", "c1", { withoutReview: true })).toBe(true);
    expect(seen).toEqual([true]);
    expect(useBuilder.getState().skipReviewPref.c1 ?? false).toBe(false);
  });

  it("turned away as busy (null): none is left either", async () => {
    const { seen } = stubDone(async () => null);
    await finishAndCheck("ws", "c1", { withoutReview: true });
    expect(seen).toEqual([true]);
    expect(useBuilder.getState().skipReviewPref.c1 ?? false).toBe(false);
  });

  it("the plain press never skips", async () => {
    const { seen } = stubDone(async () => null);
    await finishAndCheck("ws", "c1");
    expect(seen[0] ?? false).toBe(false);
  });
});
