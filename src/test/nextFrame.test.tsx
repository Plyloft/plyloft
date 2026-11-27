import { describe, expect, it, vi } from "vitest";
import { nextFrameOrTimer } from "../lib/nextFrame";

function host() {
  const frames: (() => void)[] = [];
  const timers: (() => void)[] = [];
  return {
    frames,
    timers,
    requestAnimationFrame: (cb: FrameRequestCallback) => frames.push(() => cb(0)),
    cancelAnimationFrame: vi.fn(),
    setTimeout: ((cb: () => void) => timers.push(cb)) as unknown as typeof setTimeout,
    clearTimeout: vi.fn() as unknown as typeof clearTimeout,
  };
}

describe("nextFrameOrTimer", () => {
  it("runs on the frame, once, and drops the timer", () => {
    const h = host();
    const run = vi.fn();
    nextFrameOrTimer(run, 100, h);
    h.frames[0]();
    h.timers[0]();
    expect(run).toHaveBeenCalledTimes(1);
    expect(h.clearTimeout).toHaveBeenCalled();
  });

  it("runs on the timer when no frame comes (locked screen)", () => {
    const h = host();
    const run = vi.fn();
    nextFrameOrTimer(run, 100, h);
    h.timers[0]();
    h.frames[0]();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("never runs once cancelled", () => {
    const h = host();
    const run = vi.fn();
    const cancel = nextFrameOrTimer(run, 100, h);
    cancel();
    h.frames[0]();
    h.timers[0]();
    expect(run).not.toHaveBeenCalled();
  });
});
