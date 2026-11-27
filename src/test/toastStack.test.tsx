// UX-2.4: toasts at the bottom centre on the one scale. Undo runs its action
// and closes the toast; clicking the toast itself copies nothing.
// GH #296, the ToastBar spec: one toast on screen at a time (no Copy, no mono
// body), Undo 6 s. GH #297: raw text waits behind Details. E3 (owner,
// 2026-10-28): the title on its own line, the body under it, one calm surface
// for every kind (its icon says which), and "1 more message" as a press. QoL 1.168 block 8 (A2, Challenger H1): an info
// replaces a plain info, waits behind a warn or an error; an Undo never
// waits; timers hold while the window is hidden; the last ten stay readable.
import { describe, expect, it, vi } from "vitest";
import { ToastStack, toastText } from "../components/ToastStack";
import { RecentMessagesSheet } from "../components/RecentMessagesSheet";
import { pushToast, RECENT_TOASTS, UNDO_TOAST_MS, useToasts } from "../store/toastStore";
import { act, renderUi, screen } from "./render";

describe("ToastStack", () => {
  it("runs Undo and closes the toast", async () => {
    const undo = vi.fn();
    act(() => {
      pushToast({ kind: "info", title: "Card deleted", action: { label: "Undo", onClick: undo } });
    });
    const r = renderUi(<ToastStack />);
    await r.user.click(screen.getByRole("button", { name: "Undo" }));
    expect(undo).toHaveBeenCalledOnce();
    expect(useToasts.getState().toasts).toHaveLength(0);
  });

  it("shows one toast at a time: a second plain info replaces the first", () => {
    const r = renderUi(<ToastStack />);
    act(() => {
      pushToast({ kind: "info", title: "Card archived" });
      pushToast({ kind: "info", title: "PR link copied" });
    });
    expect(r.container.querySelectorAll(".toast")).toHaveLength(1);
    expect(screen.getByText("PR link copied")).toBeTruthy();
    expect(screen.queryByText("Card archived")).toBeNull();
    expect(useToasts.getState().toasts).toHaveLength(1);
  });

  it("draws the title on its own line and the body under it, with no Copy", () => {
    act(() => {
      pushToast({ kind: "info", title: "Card archived", body: "sidebar: status rows" });
    });
    const r = renderUi(<ToastStack />);
    expect(r.container.querySelector(".toast-title")?.textContent).toBe("Card archived");
    expect(r.container.querySelector(".toast-body")?.textContent).toBe("sidebar: status rows");
    // The live region still reads one sentence; the dash is for a screen
    // reader only.
    expect(r.container.querySelector(".toast-text")?.textContent).toBe("Card archived — sidebar: status rows");
    expect(r.container.querySelector(".toast-text .sr-only")?.textContent).toBe(" — ");
    // E3: every kind has its small icon; an info's is the muted one.
    expect(r.container.querySelector(".toast-icon")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /copy/i })).toBeNull();
    // Recent messages still reads the two as one sentence.
    expect(toastText({ title: "Ship stopped.", body: "Try again." })).toBe("Ship stopped. Try again.");
    // A2: never a capital after the dash — a new sentence takes a full stop.
    expect(toastText({ title: "Card restored", body: "It is back on the Board." })).toBe("Card restored. It is back on the Board.");
    // L2: a one-word title is not a sentence of its own — it takes the dash.
    expect(toastText({ title: "Saved", body: "Sidebar: status rows" })).toBe("Saved — Sidebar: status rows");
  });

  it("keeps a sentence title's full stop on its line (A2's joiner)", () => {
    act(() => {
      pushToast({ kind: "info", title: "Card restored", body: "It is back on the Board." });
    });
    const r = renderUi(<ToastStack />);
    expect(r.container.querySelector(".toast-title")?.textContent).toBe("Card restored.");
    expect(r.container.querySelector(".toast-text")?.textContent).toBe("Card restored. It is back on the Board.");
  });

  it("draws a toast with only a body as its title line, never an empty heading", () => {
    act(() => {
      pushToast({ kind: "info", title: "", body: "Copied." });
    });
    const r = renderUi(<ToastStack />);
    expect(r.container.querySelector(".toast-title")?.textContent).toBe("Copied.");
    expect(r.container.querySelector(".toast-body")).toBeNull();
  });

  it("says an error by its icon and words: no wash, the same surface as an info", () => {
    const r = renderUi(<ToastStack />);
    act(() => {
      pushToast({ kind: "error", title: "Couldn't ship the card." });
    });
    const toast = r.container.querySelector(".toast");
    expect(toast?.classList.contains("toast-error")).toBe(true);
    expect(r.container.querySelector(".toast-icon")).toBeTruthy();
    expect(r.container.querySelector(".toast-line")).toBeNull();
  });

  it("draws the action as a bordered button under the words", () => {
    act(() => {
      pushToast({ kind: "warn", title: "Claude can't review your cards yet", action: { label: "Open Claude there", onClick: () => {} } });
    });
    renderUi(<ToastStack />);
    const press = screen.getByRole("button", { name: "Open Claude there" });
    expect(press.classList.contains("cbtn")).toBe(true);
    expect(press.closest(".toast-actions")).toBeTruthy();
  });

  it("never lets an info replace an error: it waits, then shows", () => {
    const r = renderUi(<ToastStack />);
    act(() => {
      pushToast({ kind: "error", title: "Couldn't give alice a seat." });
      pushToast({ kind: "info", title: "Invite sent." });
    });
    expect(screen.getByText("Couldn't give alice a seat.")).toBeTruthy();
    expect(screen.queryByText("Invite sent.")).toBeNull();
    // E3: what waits is a press that says what it is.
    expect(screen.getByRole("button", { name: "1 more message" })).toBeTruthy();
    expect(r.container.textContent).not.toContain("· 1 more");
    expect(useToasts.getState().queue).toHaveLength(1);
    act(() => {
      useToasts.getState().dismiss(useToasts.getState().toasts[0].id);
    });
    expect(screen.getByText("Invite sent.")).toBeTruthy();
    expect(useToasts.getState().queue).toHaveLength(0);
  });

  it("1 more message shows the next one and puts this one behind it", async () => {
    const r = renderUi(<ToastStack />);
    act(() => {
      pushToast({ kind: "warn", title: "First", action: { label: "Fix it", onClick: () => {} } });
      pushToast({ kind: "warn", title: "Second", action: { label: "Open", onClick: () => {} } });
      pushToast({ kind: "warn", title: "Third", action: { label: "Open", onClick: () => {} } });
    });
    // The newest warn is on screen; the persistent ones it covered wait.
    const first = screen.getByRole("status").querySelector(".toast-title")!.textContent;
    expect(screen.getByRole("button", { name: "2 more messages" })).toBeTruthy();
    await r.user.click(screen.getByRole("button", { name: "2 more messages" }));
    const second = screen.getByRole("status").querySelector(".toast-title")!.textContent;
    expect(second).not.toBe(first);
    // Still two waiting: the one it replaced went to the back, not away.
    expect(useToasts.getState().queue).toHaveLength(2);
    expect(useToasts.getState().queue[1].title).toBe(first);
    // Keyboard: it is a real button, reachable by Tab.
    const more = screen.getByRole("button", { name: "2 more messages" });
    more.focus();
    await r.user.keyboard("{Enter}");
    expect(screen.getByRole("status").querySelector(".toast-title")!.textContent).not.toBe(second);
  });

  it("1 more message drops the press's hover hold: the first toast still times out (Reviewer 1)", async () => {
    const r = renderUi(<ToastStack />, { fakeTimers: true });
    act(() => {
      pushToast({ kind: "warn", title: "A warn that stays", action: { label: "Open", onClick: () => {} } });
      pushToast({ kind: "error", title: "First error" });
    });
    // The timed error covered the persistent warn, which waits.
    expect(screen.getByRole("status").querySelector(".toast-title")!.textContent).toBe("First error");
    await r.user.hover(screen.getByRole("status").querySelector(".toast") as HTMLElement);
    await r.user.click(screen.getByRole("button", { name: "1 more message" }));
    expect(screen.getByRole("status").querySelector(".toast-title")!.textContent).toBe("A warn that stays");
    const toast = () => screen.getByRole("status").querySelector(".toast") as HTMLElement;
    // Twice, with the pointer on the toast each time (its hover hold).
    await r.user.hover(toast());
    await r.user.click(screen.getByRole("button", { name: "1 more message" }));
    expect(screen.getByRole("status").querySelector(".toast-title")!.textContent).toBe("First error");
    // Focus moved to the new toast's own press, not to the page.
    expect(document.activeElement?.textContent).toBe("1 more message");
    await r.user.hover(toast());
    await r.user.click(screen.getByRole("button", { name: "1 more message" }));
    expect(screen.getByRole("status").querySelector(".toast-title")!.textContent).toBe("A warn that stays");
    // Back on screen, the error waits again; dismissing the warn shows it
    // and its time runs out, held by nothing.
    act(() => {
      useToasts.getState().dismiss(useToasts.getState().toasts[0].id);
    });
    expect(screen.getByRole("status").querySelector(".toast-title")!.textContent).toBe("First error");
    act(() => {
      vi.advanceTimersByTime(13_000);
    });
    expect(useToasts.getState().toasts).toHaveLength(0);
    vi.useRealTimers();
  });

  it("draws a second press beside the first", async () => {
    const second = vi.fn();
    act(() => {
      pushToast({
        kind: "warn",
        title: "Your project folder is behind GitHub",
        action: { label: "Show the files", onClick: () => {} },
        secondaryAction: { label: "Sync again", onClick: second },
      });
    });
    const r = renderUi(<ToastStack />);
    await r.user.click(screen.getByRole("button", { name: "Sync again" }));
    expect(second).toHaveBeenCalledOnce();
    expect(useToasts.getState().toasts).toHaveLength(0);
  });

  it("holds a toast's time while the window is hidden", () => {
    renderUi(<ToastStack />, { fakeTimers: true });
    act(() => {
      pushToast({ kind: "error", title: "Couldn't ship the card." });
    });
    // L3: the same signal `usePageVisible` reads (visibilitychange).
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    try {
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      expect(useToasts.getState().toasts).toHaveLength(1);
    } finally {
      hidden.mockReturnValue(false);
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
    }
    act(() => {
      vi.advanceTimersByTime(11_000);
    });
    expect(useToasts.getState().toasts).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(useToasts.getState().toasts).toHaveLength(0);
    hidden.mockRestore();
    vi.useRealTimers();
  });

  it("Recent messages says (undone) and folds repeats into ×N", async () => {
    const r = renderUi(<ToastStack />);
    act(() => {
      pushToast({ kind: "info", title: "Nothing pasted" });
      pushToast({ kind: "info", title: "Nothing pasted" });
      pushToast({ kind: "info", title: "Nothing pasted" });
      pushToast({ kind: "info", title: "Card deleted", action: { label: "Undo", onClick: () => {}, ttlMs: UNDO_TOAST_MS } });
    });
    await r.user.click(screen.getByRole("button", { name: "Undo" }));
    const recent = useToasts.getState().recent;
    expect(recent.map((m) => [m.title, m.times ?? 1, m.undone ?? false])).toEqual([
      ["Card deleted", 1, true],
      ["Nothing pasted", 3, false],
    ]);
    r.unmount();
    renderUi(<RecentMessagesSheet onClose={() => {}} />);
    expect(screen.getByText("(undone)", { exact: false })).toBeTruthy();
    expect(screen.getByText("×3", { exact: false })).toBeTruthy();
  });

  it("never keeps a token in Recent messages (L7)", () => {
    act(() => {
      pushToast({
        kind: "error",
        title: "Couldn't push",
        details: "fatal: https://me:ghp_abcdefghijklmnopqrstuvwxyz123456@github.com/a/b.git denied (gho_ABCDEFGHIJKLMNOP1234)",
      });
    });
    const details = useToasts.getState().recent[0].details!;
    expect(details).not.toMatch(/ghp_abc|gho_ABC|me:/);
    expect(details).toContain("://…@github.com");
  });

  it("keeps the last ten toasts for Recent messages, newest first", () => {
    act(() => {
      for (let i = 1; i <= RECENT_TOASTS + 2; i++) pushToast({ kind: "info", title: `Message ${i}` });
      pushToast({ kind: "error", title: "Couldn't move the card", details: "EACCES" });
    });
    const recent = useToasts.getState().recent;
    expect(recent).toHaveLength(RECENT_TOASTS);
    expect(recent[0].title).toBe("Couldn't move the card");
    expect(recent.map((t) => t.title)).not.toContain("Message 1");
    renderUi(<RecentMessagesSheet onClose={() => {}} />);
    expect(screen.getByText(/Couldn't move the card/)).toBeTruthy();
    expect(screen.getByText("Message 12")).toBeTruthy();
  });

  it("auto-dismisses an Undo toast at 6 s", () => {
    renderUi(<ToastStack />, { fakeTimers: true });
    act(() => {
      pushToast({ kind: "info", title: "Card deleted", action: { label: "Undo", onClick: () => {}, ttlMs: UNDO_TOAST_MS } });
    });
    act(() => {
      vi.advanceTimersByTime(5_900);
    });
    expect(useToasts.getState().toasts).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(useToasts.getState().toasts).toHaveLength(0);
    vi.useRealTimers();
  });

  it("keeps an error's raw text behind Details, and copies it only from there", async () => {
    act(() => {
      pushToast({ kind: "error", title: "Couldn't move the card", details: "EACCES: permission denied" });
    });
    const r = renderUi(<ToastStack />);
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    expect(screen.queryByText("EACCES: permission denied")).toBeNull();
    await r.user.click(screen.getByText("Couldn't move the card"));
    expect(writeText).not.toHaveBeenCalled();
    await r.user.click(screen.getByRole("button", { name: "Details" }));
    expect(screen.getByText("EACCES: permission denied")).toBeTruthy();
    await r.user.click(screen.getByRole("button", { name: "Copy the details" }));
    expect(writeText).toHaveBeenCalledWith("EACCES: permission denied");
  });

  it("offers no Details on a confirmation", () => {
    act(() => {
      pushToast({ kind: "info", title: "PR link copied" });
    });
    renderUi(<ToastStack />);
    expect(screen.queryByRole("button", { name: "Details" })).toBeNull();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeTruthy();
  });
});
