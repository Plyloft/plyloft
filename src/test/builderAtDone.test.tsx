// G11 (1.170.0): the Builder session follows the pull request. No question
// after a ship: while the pull request is open the session stays; once it
// is merged (Done) Plyloft closes it, with Undo in the toast — and a session
// the person opened after the merge is never closed by Plyloft.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KanbanCard, PrStatus } from "../ipc";
import { closingAtDone, followingSessions, sessionKey, workOnPrSince } from "../lib/builderAtDone";
import { closeBuilderWithUndo, resetBuilderAtDoneForTests, startBuilderAtDone } from "../store/builderAtDone";
import { useBuilder, writeBuilderInput } from "../store/builderStore";
import { useKanban } from "../store/kanbanStore";
import { useToasts } from "../store/toastStore";
import { act, renderUi, screen } from "./render";

const WS = "ws-1";
const pr = (state: PrStatus["state"]): PrStatus =>
  ({ number: 9, state, checks: "passing", failingChecks: [], mergeable: "mergeable", reviewDecision: "none" }) as never;
const card = (state: PrStatus["state"] | null, ptyId: string | null = "pty1"): KanbanCard =>
  ({
    id: "card-1",
    workspaceId: WS,
    title: "Add the export",
    columnId: state === "merged" ? "complete" : "in_progress",
    prUrl: state ? "https://github.com/o/r/pull/9" : null,
    pr: state ? pr(state) : null,
    builder: { vendor: "claude", bypass: false, startedAt: 0, snapshots: [], ptyId, sessionLost: false },
    createdAt: 1,
    updatedAt: 1,
  }) as KanbanCard;
const board = (c: KanbanCard) => act(() => useKanban.setState({ byWorkspace: { [WS]: { cards: [c], loaded: true } } }));
const closedToast = () => useToasts.getState().toasts.find((t) => t.title.endsWith("so its Builder session was closed."));

afterEach(() => resetBuilderAtDoneForTests());

describe("which sessions close at Done", () => {
  it("only a session seen following the open pull request, once it is merged", () => {
    expect(followingSessions([card("open"), card("open", null), card("merged"), card(null)])).toEqual([sessionKey("card-1", "pty1")]);
    const following = new Set([sessionKey("card-1", "pty1")]);
    expect(closingAtDone([card("merged")], following)).toEqual([{ cardId: "card-1", ptyId: "pty1" }]);
    expect(closingAtDone([card("open")], following)).toEqual([]);
    // Closed without a merge: not Done.
    expect(closingAtDone([card("closed")], following)).toEqual([]);
    // Resumed after the merge: another session, the person's own.
    expect(closingAtDone([card("merged", "pty2")], following)).toEqual([]);
  });
});

describe("the session closes at Done, with Undo", () => {
  it("closes once the toast has gone, after the pull request merged", async () => {
    const { tauri } = renderUi(<div />, {
      fakeTimers: true,
      withToasts: true,
      fixtures: { builder_close: null, kanban_load: [card("merged", null)] },
    });
    board(card("open"));
    startBuilderAtDone();
    expect(closedToast()).toBeUndefined();
    board(card("merged"));
    // 1.171.0 B2 (DL-37): it names the card, and why.
    expect(closedToast()?.title).toBe("“Add the export” is merged, so its Builder session was closed.");
    expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
    // Not while the toast shows.
    act(() => void vi.advanceTimersByTime(1000));
    expect(tauri.callsOf("builder_close")).toHaveLength(0);
    act(() => void vi.advanceTimersByTime(6000));
    expect(tauri.callsOf("builder_close")).toHaveLength(1);
    expect(tauri.callsOf("builder_close")[0].args).toMatchObject({ workspaceId: WS, cardId: "card-1" });
  });

  it("Undo keeps the session, and it isn't closed again", async () => {
    const { user, tauri } = renderUi(<div />, { fakeTimers: true, withToasts: true, fixtures: { builder_close: null } });
    board(card("open"));
    startBuilderAtDone();
    board(card("merged"));
    await user.click(screen.getByRole("button", { name: "Undo" }));
    act(() => void vi.advanceTimersByTime(10_000));
    expect(tauri.callsOf("builder_close")).toHaveLength(0);
    board({ ...card("merged"), updatedAt: 2 });
    act(() => void vi.advanceTimersByTime(10_000));
    expect(closedToast()).toBeUndefined();
    expect(tauri.callsOf("builder_close")).toHaveLength(0);
  });

  it("waits for the toast on screen before it covers it (the ship's own line)", () => {
    const { tauri } = renderUi(<div />, {
      fakeTimers: true,
      withToasts: true,
      fixtures: { builder_close: null, kanban_load: [card(null, null)] },
    });
    board(card(null));
    act(() => void useToasts.getState().push({ kind: "info", title: "Shipped", body: "Merged into main on this Mac." }));
    act(() => closeBuilderWithUndo(WS, "card-1"));
    expect(useToasts.getState().toasts[0].title).toBe("Shipped");
    act(() => void vi.advanceTimersByTime(6500));
    expect(closedToast()).toBeTruthy();
    expect(tauri.callsOf("builder_close")).toHaveLength(0);
    act(() => void vi.advanceTimersByTime(7000));
    expect(tauri.callsOf("builder_close")).toHaveLength(1);
  });

  it("never closes a session opened after the merge, nor one already gone", () => {
    const { tauri } = renderUi(<div />, { fakeTimers: true, withToasts: true, fixtures: { builder_close: null } });
    board(card("merged", "pty2"));
    startBuilderAtDone();
    expect(closedToast()).toBeUndefined();
    // A close asked for a session that ended before the toast went.
    board(card("merged", "pty3"));
    closeBuilderWithUndo(WS, "card-1");
    expect(closedToast()).toBeTruthy();
    board(card("merged", null));
    act(() => void vi.advanceTimersByTime(10_000));
    expect(tauri.callsOf("builder_close")).toHaveLength(0);
  });
});

// G11 Challenger: a session in use is left open and nothing is said — its
// turn running, a question in view, or the person typing into it since it
// began following — checked before the toast and again before the close.
describe("a session in use stays open", () => {
  const live = (patch: { turnIdle?: boolean; questionInView?: boolean }) =>
    act(() => {
      if (!useBuilder.getState().byCard["card-1"]) useBuilder.getState().attach("card-1", WS, "pty1", "claude");
      useBuilder.setState((s) => ({ byCard: { ...s.byCard, "card-1": { ...s.byCard["card-1"]!, ...patch } } }));
    });

  it("closes an idle live session as before", () => {
    const { tauri } = renderUi(<div />, { fakeTimers: true, withToasts: true, fixtures: { builder_close: null, kanban_load: [card("merged", null)] } });
    live({ turnIdle: true });
    board(card("open"));
    startBuilderAtDone();
    board(card("merged"));
    expect(closedToast()).toBeTruthy();
    act(() => void vi.advanceTimersByTime(7000));
    expect(tauri.callsOf("builder_close")).toHaveLength(1);
  });

  it.each([
    ["its turn running", { turnIdle: false }],
    ["a question in view", { turnIdle: true, questionInView: true }],
  ])("says nothing and keeps it open with %s at Done", (_why, patch) => {
    const { tauri } = renderUi(<div />, { fakeTimers: true, withToasts: true, fixtures: { builder_close: null } });
    live(patch);
    board(card("open"));
    startBuilderAtDone();
    board(card("merged"));
    expect(closedToast()).toBeUndefined();
    act(() => void vi.advanceTimersByTime(10_000));
    expect(tauri.callsOf("builder_close")).toHaveLength(0);
  });

  it("keeps a session the person typed into since it began following", () => {
    const { tauri } = renderUi(<div />, { fakeTimers: true, withToasts: true, fixtures: { builder_close: null, pty_write: null } });
    live({ turnIdle: true });
    board(card("open"));
    startBuilderAtDone();
    act(() => void vi.advanceTimersByTime(1000));
    act(() => writeBuilderInput("pty1", "x"));
    board(card("merged"));
    expect(closedToast()).toBeUndefined();
    act(() => void vi.advanceTimersByTime(10_000));
    expect(tauri.callsOf("builder_close")).toHaveLength(0);
  });

  // 1.171.0 B walk: a fix round — typed into the session, Finish and check,
  // Send the fixes, then the card's Merge — closes at Done like any other.
  it("closes a session whose typing went into the fix that is on the pull request", () => {
    const { tauri } = renderUi(<div />, {
      fakeTimers: true,
      withToasts: true,
      fixtures: { builder_close: null, pty_write: null, kanban_load: [card("merged", null)] },
    });
    live({ turnIdle: true });
    board(card("open"));
    startBuilderAtDone();
    act(() => void vi.advanceTimersByTime(1000));
    act(() => writeBuilderInput("pty1", "also export it in the README\r"));
    act(() => void vi.advanceTimersByTime(1000));
    const fixed = (state: PrStatus["state"]): KanbanCard => {
      const c = card(state);
      return {
        ...c,
        pr: { ...c.pr!, headSha: "fix2" },
        builder: { ...c.builder!, snapshots: [{ n: 1, sha: "one1", at: 1 }, { n: 2, sha: "fix2", at: Date.now() }] },
      };
    };
    board(fixed("open"));
    board(fixed("merged"));
    expect(closedToast()?.title).toBe("“Add the export” is merged, so its Builder session was closed.");
    act(() => void vi.advanceTimersByTime(10_000));
    expect(tauri.callsOf("builder_close")).toHaveLength(1);
  });

  // Challenger: Send the fixes recorded the push while GitHub's head is
  // still the commit before it — found through pushedHead alone.
  it("finds the fix through the pushed head alone, and closes", () => {
    const { tauri } = renderUi(<div />, {
      fakeTimers: true,
      withToasts: true,
      fixtures: { builder_close: null, pty_write: null, kanban_load: [card("merged", null)] },
    });
    live({ turnIdle: true });
    board(card("open"));
    startBuilderAtDone();
    act(() => void vi.advanceTimersByTime(1000));
    act(() => writeBuilderInput("pty1", "also export it in the README"));
    act(() => void vi.advanceTimersByTime(1000));
    const c = card("open");
    const sent = (state: PrStatus["state"]): KanbanCard => ({
      ...c,
      pr: { ...c.pr!, state, headSha: "one1", pushedHead: "fix2" },
      builder: { ...c.builder!, snapshots: [{ n: 1, sha: "one1", at: 1 }, { n: 2, sha: "fix2", at: Date.now() }] },
    });
    expect(workOnPrSince(sent("open"))).toBe(Date.now());
    board(sent("open"));
    board(sent("merged"));
    expect(closedToast()).toBeTruthy();
    act(() => void vi.advanceTimersByTime(10_000));
    expect(tauri.callsOf("builder_close")).toHaveLength(1);
  });

  it("keeps a session whose fixes were never sent to the pull request", () => {
    const { tauri } = renderUi(<div />, { fakeTimers: true, withToasts: true, fixtures: { builder_close: null, pty_write: null } });
    live({ turnIdle: true });
    board(card("open"));
    startBuilderAtDone();
    act(() => void vi.advanceTimersByTime(1000));
    act(() => writeBuilderInput("pty1", "also export it in the README"));
    act(() => void vi.advanceTimersByTime(1000));
    const c = card("open");
    // The pull request is at snapshot 1 (from before the typing); the fix,
    // snapshot 2, is only on this computer.
    const unsent = (state: PrStatus["state"]): KanbanCard => ({
      ...c,
      pr: { ...c.pr!, state, headSha: "one1", pushedHead: "one1" },
      builder: { ...c.builder!, snapshots: [{ n: 1, sha: "one1", at: 1 }, { n: 2, sha: "fix2", at: Date.now() }] },
    });
    expect(workOnPrSince(unsent("open"))).toBe(1);
    board(unsent("open"));
    board(unsent("merged"));
    expect(closedToast()).toBeUndefined();
    act(() => void vi.advanceTimersByTime(10_000));
    expect(tauri.callsOf("builder_close")).toHaveLength(0);
  });

  it("an empty snapshot sha never matches a head", () => {
    const c = card("open");
    expect(workOnPrSince({ ...c, pr: { ...c.pr!, headSha: "abc", pushedHead: "" }, builder: { ...c.builder!, snapshots: [{ n: 1, sha: "", at: 5 }] } })).toBeNull();
  });

  it("keeps a session typed into after the fix that is on the pull request", () => {
    const { tauri } = renderUi(<div />, { fakeTimers: true, withToasts: true, fixtures: { builder_close: null, pty_write: null } });
    live({ turnIdle: true });
    const c = card("open");
    const fixed = (state: PrStatus["state"]): KanbanCard => ({
      ...card(state),
      pr: { ...c.pr!, state, headSha: "fix2" },
      builder: { ...c.builder!, snapshots: [{ n: 2, sha: "fix2", at: Date.now() }] },
    });
    board(fixed("open"));
    startBuilderAtDone();
    act(() => void vi.advanceTimersByTime(1000));
    act(() => writeBuilderInput("pty1", "x"));
    board(fixed("merged"));
    expect(closedToast()).toBeUndefined();
    act(() => void vi.advanceTimersByTime(10_000));
    expect(tauri.callsOf("builder_close")).toHaveLength(0);
  });

  it("keeps it when a turn starts or a question comes while the toast shows", () => {
    const { tauri } = renderUi(<div />, { fakeTimers: true, withToasts: true, fixtures: { builder_close: null } });
    live({ turnIdle: true });
    board(card("open"));
    startBuilderAtDone();
    board(card("merged"));
    expect(closedToast()).toBeTruthy();
    live({ questionInView: true });
    act(() => void vi.advanceTimersByTime(10_000));
    expect(tauri.callsOf("builder_close")).toHaveLength(0);
  });
});
