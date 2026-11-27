// 1.176.2 (A5F-06): a toast an Undo covered comes back with no stale hold:
// the Details hold of a bar that was unmounted, a hover that never ended, a
// `hidden` hold nobody resumed. It times out as any timed toast does.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pushToast, resetToastsForTests, setToastsPageVisible, UNDO_TOAST_MS, useToasts } from "../store/toastStore";

beforeEach(() => {
  vi.useFakeTimers();
  resetToastsForTests();
});
afterEach(() => {
  setToastsPageVisible(true);
  resetToastsForTests();
  vi.useRealTimers();
});

const undo = () =>
  pushToast({ kind: "info", title: "Card moved", action: { label: "Undo", onClick: () => {}, ttlMs: UNDO_TOAST_MS } });

describe("A covered toast returns without a stale hold", () => {
  it("an error held by Details while an Undo covered it times out afterwards", () => {
    const id = pushToast({ kind: "error", title: "Couldn't save", details: "raw text" });
    useToasts.getState().pauseTimer(id, "details");
    undo();
    expect(useToasts.getState().toasts[0].title).toBe("Card moved");
    vi.advanceTimersByTime(UNDO_TOAST_MS + 100);
    // The error is back, its bar mounted again with Details closed.
    expect(useToasts.getState().toasts[0]?.id).toBe(id);
    vi.advanceTimersByTime(10 * 60_000);
    expect(useToasts.getState().toasts).toHaveLength(0);
    expect(useToasts.getState().queue).toHaveLength(0);
  });

  it("a warn covered while the window was hidden times out once the window is back", () => {
    const id = pushToast({ kind: "warn", title: "Check this" });
    setToastsPageVisible(false);
    undo();
    setToastsPageVisible(true);
    vi.advanceTimersByTime(UNDO_TOAST_MS + 100);
    expect(useToasts.getState().toasts[0]?.id).toBe(id);
    vi.advanceTimersByTime(10 * 60_000);
    expect(useToasts.getState().toasts).toHaveLength(0);
  });

  it("an Undo pushed while the window is hidden is reachable and goes away", () => {
    setToastsPageVisible(false);
    undo();
    expect(useToasts.getState().toasts).toHaveLength(1);
    setToastsPageVisible(true);
    vi.advanceTimersByTime(UNDO_TOAST_MS + 100);
    expect(useToasts.getState().toasts).toHaveLength(0);
  });
});
