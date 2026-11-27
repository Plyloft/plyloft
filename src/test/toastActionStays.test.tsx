import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { computeTtl, pushToast, resetToastsForTests, UNDO_TOAST_MS, useToasts } from "../store/toastStore";
import { ToastStack, toastLayer, sheetToastEdge, SHEET_TOAST_ROOM, sheetToastPlace, settingsToastPlace } from "../components/ToastStack";
import { holdSheetOpen, useOpenSheets } from "../store/sheetLayerStore";
import { useUi } from "../store/uiStore";
import { Sheet } from "../components/ux/Sheet";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Owner, 2026-10-19: a toast with an action stays until it is dismissed.
// Only an action with a window of its own (Undo) still goes when it does.
describe("toast with an action", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetToastsForTests();
  });
  afterEach(() => vi.useRealTimers());

  it("stays until dismissed", () => {
    const id = pushToast({
      kind: "warn",
      title: "Couldn't update the skill",
      action: { label: "Review", onClick: () => {} },
    });
    vi.advanceTimersByTime(10 * 60_000);
    expect(useToasts.getState().toasts.map((t) => t.id)).toEqual([id]);
    useToasts.getState().dismiss(id);
    expect(useToasts.getState().toasts).toEqual([]);
  });

  // Challenger H1 (block 8): a toast that stays until dismissed is put
  // back, never dropped — the next one shows, then it comes back.
  it("an info one gives way to the next toast, then comes back", () => {
    const align = pushToast({ kind: "info", title: "Align them first", action: { label: "Align", onClick: () => {} } });
    const next = pushToast({ kind: "info", title: "Saved" });
    expect(useToasts.getState().toasts.map((t) => t.id)).toEqual([next]);
    vi.advanceTimersByTime(6000);
    expect(useToasts.getState().toasts.map((t) => t.id)).toEqual([align]);
  });

  // 1.168.1 (#12): a notice kept elsewhere ("Updated to") stays while it is
  // alone, but a newer toast replaces it for good.
  it("one marked dropWhenCovered stays alone, and is not brought back", () => {
    const notice = pushToast({
      kind: "info",
      title: "Updated to 1.168.0",
      action: { label: "What's new", onClick: () => {} },
      dropWhenCovered: true,
    });
    vi.advanceTimersByTime(10_000);
    expect(useToasts.getState().toasts.map((t) => t.id)).toEqual([notice]);
    const warn = pushToast({ kind: "warn", title: "Couldn't save" });
    expect(useToasts.getState().toasts.map((t) => t.id)).toEqual([warn]);
    expect(useToasts.getState().queue).toEqual([]);
    useToasts.getState().dismiss(warn);
    expect(useToasts.getState().toasts).toEqual([]);
  });

  // Challenger (#12): covered at app start, before anyone has seen it, it
  // is put back like any toast that stays — and comes back after.
  it("one marked dropWhenCovered, covered within 1 s, comes back after", () => {
    const notice = pushToast({
      kind: "info",
      title: "Updated to 1.168.0",
      action: { label: "What's new", onClick: () => {} },
      dropWhenCovered: true,
    });
    vi.advanceTimersByTime(500);
    const next = pushToast({ kind: "info", title: "Codex updated" });
    expect(useToasts.getState().toasts.map((t) => t.id)).toEqual([next]);
    expect(useToasts.getState().queue.map((t) => t.id)).toEqual([notice]);
    useToasts.getState().dismiss(next);
    expect(useToasts.getState().toasts.map((t) => t.id)).toEqual([notice]);
    useToasts.getState().dismiss(notice);
  });

  // A2 / H1 (3): an info waits behind a persistent warn at most 12 s; then
  // it shows and the warn comes back right after it.
  it("a warn one keeps the screen 12 s; the info shows, then the warn is back", () => {
    const warn = pushToast({ kind: "warn", title: "Align them first", action: { label: "Align", onClick: () => {} } });
    const next = pushToast({ kind: "info", title: "Saved" });
    vi.advanceTimersByTime(11_000);
    expect(useToasts.getState().toasts.map((t) => t.id)).toEqual([warn]);
    vi.advanceTimersByTime(1_000);
    expect(useToasts.getState().toasts.map((t) => t.id)).toEqual([next]);
    expect(useToasts.getState().queue.map((t) => t.id)).toEqual([warn]);
    vi.advanceTimersByTime(6_000);
    expect(useToasts.getState().toasts.map((t) => t.id)).toEqual([warn]);
  });

  it("delete during a persistent error: the Undo is on screen at once, and the error comes back", () => {
    const err = pushToast({ kind: "error", title: "Couldn't update the skill", action: { label: "Review", onClick: () => {} } });
    const undo = pushToast({ kind: "info", title: "Card deleted", action: { label: "Undo", onClick: () => {}, ttlMs: UNDO_TOAST_MS } });
    expect(useToasts.getState().toasts.map((t) => t.id)).toEqual([undo]);
    expect(useToasts.getState().queue.map((t) => t.id)).toEqual([err]);
    vi.advanceTimersByTime(UNDO_TOAST_MS);
    expect(useToasts.getState().toasts.map((t) => t.id)).toEqual([err]);
  });

  it("a timed error covered by an Undo comes back with what was left of its time", () => {
    const err = pushToast({ kind: "error", title: "The card wasn't shipped" });
    vi.advanceTimersByTime(4_000);
    pushToast({ kind: "info", title: "Card deleted", action: { label: "Undo", onClick: () => {}, ttlMs: UNDO_TOAST_MS } });
    vi.advanceTimersByTime(UNDO_TOAST_MS);
    expect(useToasts.getState().toasts.map((t) => t.id)).toEqual([err]);
    vi.advanceTimersByTime(7_900);
    expect(useToasts.getState().toasts.map((t) => t.id)).toEqual([err]);
    vi.advanceTimersByTime(200);
    expect(useToasts.getState().toasts).toEqual([]);
  });

  it("delete A, delete B, a warn, Undo on B: Undo A is back on screen before the warn", () => {
    const undoA = pushToast({ kind: "info", title: "A deleted", action: { label: "Undo", onClick: () => {}, ttlMs: UNDO_TOAST_MS } });
    vi.advanceTimersByTime(1_000);
    const undoB = pushToast({ kind: "info", title: "B deleted", action: { label: "Undo", onClick: () => {}, ttlMs: UNDO_TOAST_MS } });
    expect(useToasts.getState().toasts.map((t) => t.id)).toEqual([undoB]);
    const warn = pushToast({ kind: "warn", title: "Card not moved" });
    expect(useToasts.getState().queue.map((t) => t.id)).toEqual([undoA, warn]);
    // Undo on B: the toast goes, and Undo A — still in its window — shows.
    useToasts.getState().dismiss(undoB);
    expect(useToasts.getState().toasts.map((t) => t.id)).toEqual([undoA]);
    vi.advanceTimersByTime(UNDO_TOAST_MS - 1_000);
    expect(useToasts.getState().toasts.map((t) => t.id)).toEqual([warn]);
  });

  // Final Mac walk: a plain card delete's Undo stays its whole window
  // (boardStore's UNDO_WINDOW_MS), whatever arrives or was on screen.
  for (const [what, before] of [
    ["alone", () => {}],
    ["over a persistent info", () => pushToast({ kind: "info", title: "Updated", action: { label: "What's new", onClick: () => {} } })],
    ["over a timed error", () => pushToast({ kind: "error", title: "The card wasn't shipped" })],
    ["over a persistent error", () => pushToast({ kind: "error", title: "The card wasn't shipped", action: { label: "Show", onClick: () => {} } })],
  ] as const) {
    it(`an Undo shown at once stays its whole window (${what})`, () => {
      (before as () => void)();
      vi.advanceTimersByTime(3_000);
      const undo = pushToast({ kind: "info", title: "Card deleted", action: { label: "Undo", onClick: () => {}, ttlMs: UNDO_TOAST_MS } });
      pushToast({ kind: "info", title: "Board reloaded" });
      pushToast({ kind: "warn", title: "Card not moved" });
      useToasts.getState().pauseTimer(undo, "hover");
      vi.advanceTimersByTime(1_000);
      useToasts.getState().resumeTimer(undo, "hover");
      vi.advanceTimersByTime(UNDO_TOAST_MS - 1);
      expect(useToasts.getState().toasts.map((t) => t.id)).toEqual([undo]);
    });
  }

  it("error with an action, then a newer error: the newer shows, the first comes back", () => {
    const first = pushToast({ kind: "error", title: "Couldn't push", action: { label: "Review", onClick: () => {} } });
    const second = pushToast({ kind: "error", title: "Couldn't sync" });
    expect(useToasts.getState().toasts.map((t) => t.id)).toEqual([second]);
    vi.advanceTimersByTime(12_000);
    expect(useToasts.getState().toasts.map((t) => t.id)).toEqual([first]);
  });

  it("a newer timed error replaces an older timed one", () => {
    pushToast({ kind: "error", title: "Couldn't push" });
    const second = pushToast({ kind: "error", title: "Couldn't sync" });
    expect(useToasts.getState().toasts.map((t) => t.id)).toEqual([second]);
    expect(useToasts.getState().queue).toEqual([]);
  });

  it("an Undo keeps its own window", () => {
    pushToast({ kind: "info", title: "Card moved", action: { label: "Undo", onClick: () => {}, ttlMs: 5000 } });
    vi.advanceTimersByTime(4999);
    expect(useToasts.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(useToasts.getState().toasts).toEqual([]);
  });

  it("pausing and resuming a toast with no timer is harmless", () => {
    const id = pushToast({ kind: "error", title: "x", action: { label: "Review", onClick: () => {} } });
    useToasts.getState().pauseTimer(id);
    useToasts.getState().resumeTimer(id);
    vi.advanceTimersByTime(60_000);
    expect(useToasts.getState().toasts).toHaveLength(1);
  });

  it("1.176.1 walk: an Undo that stays until dismissed is not hidden by a warn raised with it", () => {
    const undo = pushToast({ kind: "info", title: "Program folders changed", action: { label: "Undo", onClick: () => {} } });
    const warn = pushToast({ kind: "warn", title: "Something unrelated" });
    expect(useToasts.getState().toasts.map((t) => t.id)).toEqual([undo]);
    expect(useToasts.getState().queue.map((t) => t.id)).toEqual([warn]);
    // Dismissed, the warn shows.
    useToasts.getState().dismiss(undo);
    expect(useToasts.getState().toasts.map((t) => t.id)).toEqual([warn]);
  });

  it("walk 3: an Undo lives as long as every Undo, then a later toast has the screen", () => {
    const undo = pushToast({ kind: "info", title: "Program folders changed", action: { label: "Undo", onClick: () => {} } });
    expect(useToasts.getState().toasts[0].action?.ttlMs).toBe(UNDO_TOAST_MS);
    const warn = pushToast({ kind: "warn", title: "Later news" });
    expect(useToasts.getState().toasts.map((t) => t.id)).toEqual([undo]);
    vi.advanceTimersByTime(UNDO_TOAST_MS + 1);
    // Gone for good, never "1 more message" behind the next one.
    expect(useToasts.getState().toasts.map((t) => t.id)).toEqual([warn]);
    expect(useToasts.getState().queue).toEqual([]);
    const next = pushToast({ kind: "warn", title: "Newer news" });
    expect(useToasts.getState().toasts.map((t) => t.id)).toEqual([next]);
    expect(useToasts.getState().queue.map((t) => t.id)).not.toContain(undo);
  });

  it("walk 3: Repair's Undo goes when the setting changes again, by anyone", async () => {
    const { offerFoldersUndo } = await import("../store/repairStore");
    const { useSettings, DEFAULT_SETTINGS } = await import("../store/settingsStore");
    const at = (pathOverride: string | null) =>
      useSettings.setState({ settings: { ...DEFAULT_SETTINGS, shell: { ...DEFAULT_SETTINGS.shell, pathOverride } } });
    useSettings.setState({ load: async () => {} } as never);
    at("/new:/usr/bin");
    offerFoldersUndo({ kind: "addProgramFolder", was: "/usr/bin", id: "s1" } as never, "/new:/usr/bin");
    expect(useToasts.getState().toasts[0]?.title).toBe("Program folders changed");
    at("/other");
    expect(useToasts.getState().toasts).toEqual([]);
    at(null);
  });

  it("a warn first, then an Undo: the Undo takes the screen", () => {
    const warn = pushToast({ kind: "warn", title: "Something unrelated" });
    const undo = pushToast({ kind: "info", title: "Program folders changed", action: { label: "Undo", onClick: () => {} } });
    expect(useToasts.getState().toasts.map((t) => t.id)).toEqual([undo]);
    expect(useToasts.getState().queue.map((t) => t.id)).toEqual([warn]);
  });

  it("toasts without an action keep their timers", () => {
    expect(computeTtl({ kind: "info", title: "a" })).toBe(6000);
    expect(computeTtl({ kind: "error", title: "a" })).toBe(12000);
    expect(computeTtl({ kind: "info", title: "a", action: { label: "Review", onClick: () => {} } })).toBeNull();
  });
});

// X2 round 1 (owner, 2026-10-31): toasts sit above the content, never above a
// sheet or Settings — a toast raised from inside Settings shows above it.
describe("the toast's layer", () => {
  beforeEach(() => resetToastsForTests());

  it("a toast pushed while the Settings overlay holds the focus is Settings'", () => {
    const backdrop = document.createElement("div");
    backdrop.className = "ux-backdrop";
    const button = document.createElement("button");
    backdrop.appendChild(button);
    document.body.appendChild(backdrop);
    try {
      button.focus();
      pushToast({ kind: "info", title: "Report copied" });
      expect(useToasts.getState().toasts[0].scope).toBe("settings");
      button.blur();
      resetToastsForTests();
      pushToast({ kind: "info", title: "Card archived" });
      expect(useToasts.getState().toasts[0].scope).toBeUndefined();
    } finally {
      backdrop.remove();
    }
  });

  it("picks the layer: a sheet first, then Setup, then Settings' own", () => {
    expect(toastLayer({ sheetOpen: false, overSetup: false, settingsOpen: false })).toBe("content");
    // 1.176.1 walk 2: what is open decides, never where the focus was.
    expect(toastLayer({ sheetOpen: false, overSetup: false, settingsOpen: true })).toBe("modal");
    expect(toastLayer({ sheetOpen: false, overSetup: false, settingsOpen: true, scope: "settings" })).toBe("modal");
    expect(toastLayer({ sheetOpen: false, overSetup: false, settingsOpen: false, scope: "settings" })).toBe("content");
    expect(toastLayer({ sheetOpen: true, overSetup: false, settingsOpen: true, scope: "settings" })).toBe("sheet");
    expect(toastLayer({ sheetOpen: false, overSetup: true, settingsOpen: false })).toBe("setup");
    expect(toastLayer({ sheetOpen: true, overSetup: true, settingsOpen: false })).toBe("sheet");
  });

  it("1.176.1 walk 2: a toast raised from a store event, with no click and no focus, is above Settings", () => {
    useUi.setState({ settingsOverlayOpen: true });
    try {
      const { container, unmount } = render(<ToastStack />);
      (document.activeElement as HTMLElement | null)?.blur();
      act(() => {
        useToasts.getState().push({ kind: "info", title: "Program folders changed", action: { label: "Undo", onClick: () => {} } });
      });
      expect(useToasts.getState().toasts[0].scope).toBeUndefined();
      expect(container.querySelector(".toast-stack")?.className).toBe("toast-stack toast-stack--modal");
      unmount();
    } finally {
      useUi.setState({ settingsOverlayOpen: false });
    }
  });

  it("1.176.1 walk 2: a sheet over Settings, closing while the Undo shows: the toast follows to Settings' layer", () => {
    useUi.setState({ settingsOverlayOpen: true });
    try {
      const { container, unmount } = render(<ToastStack />);
      let release = () => {};
      act(() => {
        release = holdSheetOpen();
      });
      act(() => {
        useToasts.getState().push({ kind: "info", title: "Program folders changed", action: { label: "Undo", onClick: () => {} } });
      });
      expect(container.querySelector(".toast-stack")?.className).toBe("toast-stack toast-stack--sheet");
      act(() => release());
      expect(container.querySelector(".toast-stack")?.className).toBe("toast-stack toast-stack--modal");
      expect(container.querySelector(".toast")?.textContent).toMatch(/Program folders changed/);
      unmount();
    } finally {
      useUi.setState({ settingsOverlayOpen: false });
    }
  });

  it("Windows walk: a toast raised before Settings opens is above Settings once it does", () => {
    const { container, unmount } = render(<ToastStack />);
    act(() => {
      useToasts.getState().push({ kind: "info", title: "Updated to 1.176.1", action: { label: "What's new", onClick: () => {} } });
    });
    expect(container.querySelector(".toast-stack")?.className).toBe("toast-stack");
    act(() => useUi.setState({ settingsOverlayOpen: true }));
    try {
      expect(container.querySelector(".toast-stack")?.className).toBe("toast-stack toast-stack--modal");
      // …and above a sheet opened over Settings while it shows.
      let release = () => {};
      act(() => {
        release = holdSheetOpen();
      });
      expect(container.querySelector(".toast-stack")?.className).toBe("toast-stack toast-stack--sheet");
      act(() => release());
    } finally {
      act(() => useUi.setState({ settingsOverlayOpen: false }));
      unmount();
    }
  });

  it("an open sheet puts the stack above it; Settings' toast rises without one", () => {
    useUi.setState({ settingsOverlayOpen: true });
    try {
      const { container, unmount } = render(<ToastStack />);
      act(() => {
        useToasts.getState().push({ kind: "info", title: "Saved", scope: "settings" });
      });
      expect(container.querySelector(".toast-stack")?.className).toBe("toast-stack toast-stack--modal");
      let release = () => {};
      act(() => {
        release = holdSheetOpen();
      });
      expect(container.querySelector(".toast-stack")?.className).toBe("toast-stack toast-stack--sheet");
      act(() => release());
      expect(container.querySelector(".toast-stack")?.className).toBe("toast-stack toast-stack--modal");
      unmount();
    } finally {
      useUi.setState({ settingsOverlayOpen: false });
    }
  });

  // 1.176.1: a real sheet plus a toast with an action raised from inside
  // it: the stack is in the layer above the sheet's backdrop, the action
  // can be pressed, focus stays where it was, and it is announced once.
  it("a toast raised inside a sheet is above the backdrop, pressable, and takes no focus", () => {
    const onClick = vi.fn();
    const { container, unmount } = render(
      <>
        <Sheet title="Report" onClose={() => {}} actions={<button type="button">Done</button>}>
          <p>Body</p>
        </Sheet>
        <ToastStack />
      </>,
    );
    const stack = container.querySelector(".toast-stack") as HTMLElement;
    expect(stack.className).toBe("toast-stack toast-stack--sheet");
    const css = readFileSync(join(process.cwd(), "src/App.css"), "utf8");
    const z = (name: string) => Number(new RegExp(`${name}:\\s*(\\d+)`).exec(css)?.[1]);
    expect(z("--z-toast-sheet")).toBeGreaterThan(z("--z-sheet"));
    expect(z("--z-toast-sheet")).toBeGreaterThan(z("--z-setup-sheet"));
    expect(css).toMatch(/\.toast-stack--sheet\s*\{[^}]*top:/);
    const surface = container.querySelector(".ux-sheet") as HTMLElement;
    expect(container.querySelector(".ux-sheet-backdrop")?.contains(stack)).toBe(false);
    const before = document.activeElement;
    act(() => {
      useToasts.getState().push({ kind: "info", title: "Report copied", action: { label: "Open", onClick } });
    });
    expect(document.activeElement).toBe(before);
    expect(stack.getAttribute("aria-live")).toBe("polite");
    expect(stack.querySelectorAll(".toast")).toHaveLength(1);
    const btn = stack.querySelector(".toast-action-btn") as HTMLElement;
    expect(surface.contains(btn)).toBe(false);
    act(() => btn.click());
    expect(onClick).toHaveBeenCalledTimes(1);
    unmount();
  });

  // 1.176.1: where over a sheet. Top unless the sheet reaches up into the
  // room; then the bottom if it leaves room there; else the top, over its head.
  it("walk 3: with a sheet open, the window's top-right corner, which a centred sheet doesn't reach", () => {
    // The walk's numbers: window 1280×820, the Repair Codex sheet y 207–690,
    // a toast 524×88.
    const win = { width: 1280, height: 820 };
    const sheet = { top: 207, bottom: 690, left: 320, right: 960 };
    const place = sheetToastPlace(sheet, win, { width: 524, height: 88 })!;
    expect(place).toEqual({ top: 12, right: 12, width: 524 });
    // It meets the sheet nowhere: its bottom (100) is above the sheet (207).
    expect(place.top + 88).toBeLessThan(sheet.top);
    // The Repair Claude sheet reaching up to y 60: the corner would meet it,
    // there is no room above, so below it.
    expect(sheetToastPlace({ top: 60, bottom: 600, left: 320, right: 960 }, win, { width: 524, height: 88 })?.top).toBe(612);
    // A sheet nearly the window's height: the corner, over its title band.
    expect(sheetToastPlace({ top: 40, bottom: 790, left: 100, right: 1180 }, win, { width: 524, height: 88 })?.top).toBe(12);
    // A short confirm sheet: the corner, far from its buttons.
    expect(sheetToastPlace({ top: 300, bottom: 520, left: 430, right: 850 }, win, { width: 480, height: 88 })?.top).toBe(12);
    // A narrow window: never wider than the window allows.
    expect(sheetToastPlace(sheet, { width: 400, height: 820 }, { width: 524, height: 88 })?.width).toBe(376);
    expect(sheetToastPlace(null, win, { width: 480, height: 88 })).toBeNull();
  });

  it("walk 4: over Settings, top right or the foot, whichever misses the row in use and its notice", () => {
    // The walk: a 1400×897 window; the Settings surface x 199–1299,
    // y 77–877, its title bar ending at 121; a toast 105 tall.
    const win = { width: 1400, height: 897 };
    const box = { top: 77, bottom: 877, left: 199, right: 1299, width: 1100, headBottom: 121 };
    // Program folders low on the page, its notice and "Empty it" under it,
    // ending near the bottom: the top right.
    const folders = { top: 640, bottom: 850, left: 460, right: 1270 };
    expect(settingsToastPlace(box, win, 105, folders)).toEqual({ top: 133, right: 113, width: 480 });
    // A row at the top of the page: the foot.
    const topRow = { top: 130, bottom: 200, left: 460, right: 1270 };
    expect(settingsToastPlace(box, win, 105, topRow)?.top).toBe(877 - 12 - 105);
    // No row in use (nothing known): the top right; other words and
    // controls on the page are not avoided any more.
    expect(settingsToastPlace(box, win, 105, null)?.top).toBe(133);
    // A row taller than the page: both spots meet it; the one that covers
    // none of its buttons wins, even with the larger overlap.
    const tall = { top: 125, bottom: 870, left: 460, right: 1270 };
    const emptyIt = { top: 800, bottom: 830, left: 1100, right: 1200 };
    expect(settingsToastPlace(box, win, 105, tall, [emptyIt])?.top).toBe(133);
    const useIt = { top: 140, bottom: 170, left: 1100, right: 1200 };
    expect(settingsToastPlace(box, win, 105, tall, [useIt])?.top).toBe(877 - 12 - 105);
    expect(settingsToastPlace(null, win, 105, null)).toBeNull();
  });

  it("picks the edge so it never covers the sheet's foot or, if it can help it, its head", () => {
    expect(sheetToastEdge(null, 600)).toBe("top");
    expect(sheetToastEdge({ top: SHEET_TOAST_ROOM, bottom: 500 }, 600)).toBe("top");
    expect(sheetToastEdge({ top: 20, bottom: 400 }, 600)).toBe("bottom");
    expect(sheetToastEdge({ top: 20, bottom: 580 }, 600)).toBe("top");
  });

  // A sheet kept mounted in a hidden, warmed workspace host counts only
  // while the host is shown.
  it("a sheet in a hidden workspace host doesn't count until the host is shown", async () => {
    const host = document.createElement("div");
    host.className = "workspace-host hidden";
    document.body.appendChild(host);
    const { unmount } = render(
      <Sheet title="Hidden" onClose={() => {}}>
        <p>x</p>
      </Sheet>,
      { container: host.appendChild(document.createElement("div")) },
    );
    expect(useOpenSheets.getState().count).toBe(0);
    host.className = "workspace-host";
    await act(async () => {
      await Promise.resolve();
    });
    expect(useOpenSheets.getState().count).toBe(1);
    host.className = "workspace-host hidden";
    await act(async () => {
      await Promise.resolve();
    });
    expect(useOpenSheets.getState().count).toBe(0);
    unmount();
    host.remove();
    expect(useOpenSheets.getState().count).toBe(0);
  });
});
