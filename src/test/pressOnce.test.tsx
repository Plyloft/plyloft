// 1.176.2 F2: the one-press-at-a-time slot, and that it is freed on every way
// a press ends — a slot that stayed taken would leave the press dead.
import { describe, expect, it } from "vitest";
import { pressOnce, pressRunning, shipPressKey } from "../lib/pressOnce";

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("pressOnce", () => {
  it("takes the slot before the first await: two presses in the same tick run once", async () => {
    const gate = deferred();
    let runs = 0;
    const fn = async () => {
      runs += 1;
      await gate.promise;
      return "done";
    };
    const a = pressOnce("k1", fn);
    const b = pressOnce("k1", fn);
    expect(runs).toBe(1);
    expect(pressRunning("k1")).toBe(true);
    gate.resolve();
    expect(await a).toBe("done");
    expect(await b).toBeUndefined();
    expect(pressRunning("k1")).toBe(false);
  });

  it("frees the slot when the press succeeds", async () => {
    await pressOnce("k2", async () => 1);
    expect(pressRunning("k2")).toBe(false);
    expect(await pressOnce("k2", async () => 2)).toBe(2);
  });

  it("frees the slot when the press throws (an error or a refusal)", async () => {
    await expect(
      pressOnce("k3", async () => {
        throw new Error("SHIP_BUSY");
      }),
    ).rejects.toThrow("SHIP_BUSY");
    expect(pressRunning("k3")).toBe(false);
    expect(await pressOnce("k3", async () => "again")).toBe("again");
  });

  it("frees the slot when the press throws before its first await", async () => {
    await expect(
      pressOnce("k4", () => {
        throw new Error("sync");
      }),
    ).rejects.toThrow("sync");
    expect(pressRunning("k4")).toBe(false);
  });

  it("frees the slot when the press stops early (cancelled, returns nothing)", async () => {
    const answer = deferred<"cancel">();
    const p = pressOnce("k5", async () => {
      if ((await answer.promise) === "cancel") return undefined;
      return "shipped";
    });
    expect(pressRunning("k5")).toBe(true);
    answer.resolve("cancel");
    await p;
    expect(pressRunning("k5")).toBe(false);
  });

  it("keeps different cards apart", async () => {
    const gate = deferred();
    let runs = 0;
    const fn = async () => {
      runs += 1;
      await gate.promise;
    };
    const a = pressOnce(shipPressKey("ws", "c1"), fn);
    const b = pressOnce(shipPressKey("ws", "c2"), fn);
    expect(runs).toBe(2);
    gate.resolve();
    await Promise.all([a, b]);
  });
});
