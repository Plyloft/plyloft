// The sidebar's stack of other workspaces: below the current workspace's
// section, every other workspace where a session waits for its person,
// something failed, or something works — so a person on seven workspaces sees
// who finished without opening the switcher — then, in the slots left under
// the one cap of five, the workspaces used recently this session, idle now,
// as plain rows. Its words and order are lib/workspaceStack.ts's (tested
// under node); this is what the rows do: names, clicks, the cap, and a row
// that gains or loses its state staying put (focus included) until the new
// order holds.
import { describe, expect, it, vi } from "vitest";
import { WorkspaceSidebar } from "../components/WorkspaceSidebar";
import { useWorkspaces, type Workspace } from "../store/workspaceStore";
import { useTiles, type Tile } from "../store/tileStore";
import { useKanban } from "../store/kanbanStore";
import { useInbox } from "../store/inboxStore";
import { useUi } from "../store/uiStore";
import { REORDER_HOLD_MS } from "../lib/workspaceStack";
import type { InboxEvent, InboxFeed, KanbanCard } from "../ipc";
import { act, nextFrame, renderUi, screen, tauri, within } from "./render";

function ws(id: string, name: string, lastOpenedAt: number): Workspace {
  return {
    id,
    name,
    cwd: `/Users/someone/code/${name}`,
    createdAt: 1,
    lastOpenedAt,
    openFiles: [],
    activeFile: null,
  };
}

function tile(id: string, workspaceId: string, label: string, quietFor: number): Tile {
  const now = Date.now();
  return {
    id,
    workspaceId,
    kind: "claude",
    ptyId: `pty-${id}`,
    label,
    cwd: "/tmp",
    startedAt: now - 120_000,
    status: "running",
    pendingClose: false,
    expanded: false,
    lastOutputAt: now - quietFor,
    // QoL 1.168 (D7): a quiet one is back at Ready after a turn.
    readiness:
      quietFor < 2_000
        ? { lastOutputAt: now - quietFor, matcherIdle: false, leftReadyAt: now - 60_000 }
        : { lastOutputAt: now - quietFor, matcherIdle: true, leftReadyAt: now - 90_000 },
    ...(quietFor < 2_000 ? {} : { submittedAt: now - 90_000 }),
  };
}
/** Quiet a minute: waiting for its person. */
const waitingTile = (id: string, w: string, label: string) => tile(id, w, label, 60_000);
/** Printing now: working. */
const workingTile = (id: string, w: string, label: string) => tile(id, w, label, 0);

function seedTiles(byWs: Record<string, Tile[]>) {
  const byWorkspace: Record<string, { tiles: Tile[]; expandedTileId: string | null; detailTileId: string | null }> = {};
  for (const [w, tiles] of Object.entries(byWs)) {
    byWorkspace[w] = { tiles, expandedTileId: null, detailTileId: null };
  }
  useTiles.setState({ byWorkspace });
}

function feed(events: Partial<InboxEvent>[]): InboxFeed {
  return {
    generatedAt: 0,
    windowDays: 7,
    costRollup: [],
    eligibilityProof: {} as InboxFeed["eligibilityProof"],
    events: events.map((e, i) => ({
      id: `ev-${i}`,
      kind: "review_needed",
      group: "needs_you",
      workspaceId: "?",
      workspaceName: "?",
      cardId: null,
      runId: null,
      title: "A card",
      detail: null,
      url: null,
      at: Date.now() - 60_000,
      seenAt: null,
      seenEligible: true,
      ...e,
    })),
  };
}

async function renderWith(workspaces: Workspace[], activeId: string) {
  tauri().allowUnhandled();
  tauri().fixture("drain_status", { draining: false, startedAt: null });
  tauri().fixture("ship_pending_count", 0);
  tauri().fixture("ship_pending_cards", null);
  tauri().fixture("ship_unverified_count", 0);
  act(() => {
    useWorkspaces.setState({ workspaces, activeId });
  });
  const r = renderUi(<WorkspaceSidebar env={null} />);
  await nextFrame();
  return r;
}

const stack = () => screen.getByRole("region", { name: "Other workspaces" });
const rowNames = () =>
  within(stack())
    .queryAllByRole("button")
    .filter((b) => b.classList.contains("shell-stack-open"))
    .map((b) => b.getAttribute("aria-label"));

const WS = [
  ws("a", "alpha", 60),
  ws("b", "beta", 50),
  ws("c", "gamma", 40),
  ws("d", "delta", 30),
  ws("e", "epsilon", 20),
];

describe("the stack of other workspaces", () => {
  it("lists the active others, needs you first, never the current one; idle ones behind 'N more workspaces'", async () => {
    act(() =>
      seedTiles({
        a: [waitingTile("a1", "a", "alpha claude")],
        b: [workingTile("b1", "b", "beta claude")],
        c: [waitingTile("c1", "c", "gamma claude"), workingTile("c2", "c", "gamma tests")],
      }),
    );
    await renderWith(WS, "a");
    expect(rowNames()).toEqual(["gamma, 1 needs you, 1 working", "beta, 1 working"]);
    // The words are on screen, not only in the name.
    expect(stack().textContent).toContain("1 needs you");
    expect(stack().textContent).toContain("1 working");
    // delta and epsilon have nothing going on: one quiet row for them.
    expect(within(stack()).getByRole("button", { name: "2 more workspaces" })).toBeTruthy();
  });

  it("switches on a click on the name, the switcher's way", async () => {
    act(() => seedTiles({ b: [workingTile("b1", "b", "beta claude")] }));
    act(() => useUi.getState().setCenterMode("b", "inbox"));
    const r = await renderWith(WS, "a");
    await r.user.click(within(stack()).getByRole("button", { name: "beta, 1 working" }));
    expect(useWorkspaces.getState().activeId).toBe("b");
    // Left on a global view, it opens on its Board — as from the switcher.
    expect(useUi.getState().centerMode.b).toBe("board");
  });

  it("expands in place with its chevron, remembered per workspace", async () => {
    act(() =>
      seedTiles({
        b: [waitingTile("b1", "b", "api"), workingTile("b2", "b", "tests")],
        c: [workingTile("c1", "c", "docs")],
      }),
    );
    const r = await renderWith(WS, "a");
    const chevron = within(stack()).getByRole("button", { name: "Show what is going on in beta" });
    expect(chevron.getAttribute("aria-expanded")).toBe("false");
    expect(within(stack()).queryByRole("list", { name: "In beta" })).toBeNull();
    await r.user.click(chevron);
    const list = within(stack()).getByRole("list", { name: "In beta" });
    expect(
      within(list).getAllByRole("button").map((b) => b.getAttribute("aria-label")),
    ).toEqual(["api, Claude finished · see what it did", "tests, working"]);
    const hide = within(stack()).getByRole("button", { name: "Hide what is going on in beta" });
    expect(hide.getAttribute("aria-expanded")).toBe("true");
    expect(hide.getAttribute("aria-controls")).toBe(list.id);
    expect(useUi.getState().stackExpanded).toEqual({ b: true });
    // gamma stays collapsed.
    expect(within(stack()).queryByRole("list", { name: "In gamma" })).toBeNull();
    await r.user.click(hide);
    expect(within(stack()).queryByRole("list", { name: "In beta" })).toBeNull();
  });

  it("answers the keyboard: Tab to the row, Right and Left expand and collapse, Space on the chevron, Enter switches", async () => {
    act(() => seedTiles({ b: [workingTile("b1", "b", "tests")] }));
    const r = await renderWith(WS, "a");
    const row = within(stack()).getByRole("button", { name: "beta, 1 working" });
    row.focus();
    await r.user.keyboard("{ArrowRight}");
    expect(within(stack()).getByRole("list", { name: "In beta" })).toBeTruthy();
    await r.user.keyboard("{ArrowLeft}");
    expect(within(stack()).queryByRole("list", { name: "In beta" })).toBeNull();
    await r.user.tab();
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Show what is going on in beta",
    );
    await r.user.keyboard(" ");
    expect(within(stack()).getByRole("list", { name: "In beta" })).toBeTruthy();
    row.focus();
    await r.user.keyboard("{Enter}");
    expect(useWorkspaces.getState().activeId).toBe("b");
  });

  it("an item switches to its workspace and opens that tile in Terminals", async () => {
    act(() => seedTiles({ b: [waitingTile("b1", "b", "api"), workingTile("b2", "b", "tests")] }));
    act(() => useUi.getState().toggleStackExpanded("b", true));
    const r = await renderWith(WS, "a");
    await r.user.click(within(stack()).getByRole("button", { name: "tests, working" }));
    expect(useWorkspaces.getState().activeId).toBe("b");
    expect(useUi.getState().centerMode.b).toBe("terminals");
    expect(useTiles.getState().byWorkspace.b.expandedTileId).toBe("b2");
  });

  it("an item from the Inbox feed (a cold workspace's card) switches and opens the card", async () => {
    act(() => {
      useKanban.setState({
        byWorkspace: {
          d: { cards: [{ id: "k1", title: "Rollback tests" } as KanbanCard] },
        } as never,
      });
      useInbox.setState({
        feed: feed([
          { workspaceId: "d", workspaceName: "delta", cardId: "k1", title: "Rollback tests" },
        ]),
      });
    });
    tauri().fixture("inbox_mark_seen", null);
    act(() => useUi.getState().toggleStackExpanded("d", true));
    const r = await renderWith(WS, "a");
    expect(rowNames()).toEqual(["delta, 1 needs you"]);
    await r.user.click(
      within(stack()).getByRole("button", { name: "Rollback tests, The work is done · review it" }),
    );
    expect(useWorkspaces.getState().activeId).toBe("d");
    expect(useUi.getState().selectedCardId.d).toBe("k1");
    expect(useUi.getState().centerMode.d).toBe("board");
  });

  it("caps at five, with 'N more active' that shows the rest", async () => {
    const many = Array.from({ length: 8 }, (_, i) => ws(`w${i}`, `ws ${i}`, 100 - i));
    const tiles: Record<string, Tile[]> = {};
    for (const w of many.slice(1)) tiles[w.id] = [workingTile(`${w.id}-t`, w.id, "claude")];
    act(() => seedTiles(tiles));
    const r = await renderWith(many, "w0");
    expect(rowNames()).toHaveLength(5);
    await r.user.click(within(stack()).getByRole("button", { name: "2 more active" }));
    expect(rowNames()).toHaveLength(7);
    await r.user.click(within(stack()).getByRole("button", { name: "Show fewer" }));
    expect(rowNames()).toHaveLength(5);
  });

  it("'N more workspaces' opens the switcher", async () => {
    const r = await renderWith(WS, "a");
    // Nothing going on anywhere: no stack rows, no caption, only the way in.
    expect(rowNames()).toEqual([]);
    expect(within(stack()).queryByText("Other workspaces")).toBeNull();
    await r.user.click(within(stack()).getByRole("button", { name: "4 more workspaces" }));
    await nextFrame();
    expect(screen.getByRole("dialog", { name: "Workspaces" })).toBeTruthy();
  });

  it("follows the active workspace: the one left joins the stack, the one entered leaves it", async () => {
    act(() =>
      seedTiles({
        a: [workingTile("a1", "a", "alpha tests")],
        b: [workingTile("b1", "b", "beta tests")],
      }),
    );
    const r = await renderWith(WS, "a");
    expect(rowNames()).toEqual(["beta, 1 working"]);
    await r.user.click(within(stack()).getByRole("button", { name: "beta, 1 working" }));
    expect(rowNames()).toEqual(["alpha, 1 working"]);
    // The one just left is the most recent this session.
    expect(useUi.getState().workspaceActiveAt.a).toBeGreaterThan(0);
  });

  it("keeps up with a rename and a removal while a row is expanded", async () => {
    act(() => seedTiles({ b: [workingTile("b1", "b", "tests")], c: [workingTile("c1", "c", "docs")] }));
    act(() => useUi.getState().toggleStackExpanded("b", true));
    await renderWith(WS, "a");
    expect(within(stack()).getByRole("list", { name: "In beta" })).toBeTruthy();
    act(() =>
      useWorkspaces.setState({
        workspaces: WS.map((w) => (w.id === "b" ? { ...w, name: "beta two" } : w)),
      }),
    );
    expect(rowNames()).toContain("beta two, 1 working");
    expect(within(stack()).getByRole("list", { name: "In beta two" })).toBeTruthy();
    act(() => useWorkspaces.setState({ workspaces: WS.filter((w) => w.id !== "b") }));
    expect(rowNames()).toEqual(["gamma, 1 working"]);
    expect(within(stack()).queryByRole("list", { name: /In beta/ })).toBeNull();
    // An item of a workspace that is gone opens nothing and switches nowhere.
    const { openStackItem } = await import("../components/WorkspaceStack");
    openStackItem("b", { key: "tile-b1", name: "tests", state: "working", words: "working", target: { kind: "tile", tileId: "b1" } });
    expect(useWorkspaces.getState().activeId).toBe("a");
  });

  // UX P-A Mac walk 6: every item says its words on screen (the Inbox row's,
  // under its name); the short state word is added only when its row mixes
  // states, and never repeats the words.
  it("an item says its own state only when its row mixes states", async () => {
    act(() =>
      seedTiles({
        b: [waitingTile("b1", "b", "api"), workingTile("b2", "b", "tests")],
        c: [workingTile("c1", "c", "docs"), workingTile("c2", "c", "lint")],
      }),
    );
    act(() => {
      useUi.getState().toggleStackExpanded("b", true);
      useUi.getState().toggleStackExpanded("c", true);
    });
    await renderWith(WS, "a");
    const b = within(stack()).getByRole("list", { name: "In beta" });
    expect(b.textContent).toBe("apiClaude finished · see what it didneeds youtestsworking");
    const c = within(stack()).getByRole("list", { name: "In gamma" });
    expect(c.textContent).toBe("docsworkinglintworking");
  });

  it("idle others only: no caption and no rows, just the way to the switcher", async () => {
    // A shell at its prompt is not something going on.
    const now = Date.now();
    const shell: Tile = {
      ...tile("b1", "b", "zsh", 60_000),
      kind: "shell",
      readiness: { lastOutputAt: now - 60_000, matcherIdle: true, leftReadyAt: now - 120_000 },
    };
    act(() => seedTiles({ b: [shell] }));
    await renderWith(WS, "a");
    expect(within(stack()).queryByRole("list")).toBeNull();
    expect(within(stack()).queryByText("Other workspaces")).toBeNull();
    expect(within(stack()).getAllByRole("button").map((b) => b.textContent)).toEqual(["4 more workspaces"]);
  });

  it("opening the switcher from the stack starts with an empty search", async () => {
    const many = ["alpha", "beta", "gamma", "delta", "epsilon", "lyra"].map((n, i) => ws(n, n, 10 - i));
    const r = await renderWith(many, "alpha");
    await r.user.click(screen.getByRole("button", { name: /switch workspace/ }));
    await nextFrame();
    await r.user.type(screen.getByRole("textbox", { name: "Find a workspace" }), "ly");
    await r.user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Workspaces" })).toBeNull();
    await r.user.click(within(stack()).getByRole("button", { name: "5 more workspaces" }));
    await nextFrame();
    const field = screen.getByRole("textbox", { name: "Find a workspace" }) as HTMLInputElement;
    expect(field.value).toBe("");
    expect(document.activeElement).toBe(field);
  });

  it("lists the workspaces used recently this session below the ones with a state, the current one never", async () => {
    const t = Date.now();
    act(() => {
      seedTiles({ e: [workingTile("e1", "e", "epsilon tests")] });
      // gamma before delta; alpha is current; beta not opened this session.
      useUi.setState({ workspaceActiveAt: { a: t, c: t - 1_000, d: t - 2_000, e: t - 3_000 } });
    });
    await renderWith(WS, "a");
    expect(rowNames()).toEqual([
      "epsilon, 1 working",
      "gamma, used recently",
      "delta, used recently",
    ]);
    // A recent row is the name only: no state words, no chevron.
    const gamma = within(stack()).getByRole("button", { name: "gamma, used recently" });
    expect(gamma.querySelector(".shell-stack-text")?.textContent).toBe("gamma");
    expect(gamma.querySelector(".shell-stack-summary")).toBeNull();
    expect(within(stack()).queryByRole("button", { name: /going on in gamma/ })).toBeNull();
    // "N more" counts only what is not shown: beta.
    expect(within(stack()).getByRole("button", { name: "1 more workspace" })).toBeTruthy();
  });

  it("a recent row switches to its workspace, the switcher's way", async () => {
    act(() => {
      useUi.setState({ workspaceActiveAt: { c: Date.now() - 1_000 } });
      useUi.getState().setCenterMode("c", "inbox");
    });
    const r = await renderWith(WS, "a");
    await r.user.click(within(stack()).getByRole("button", { name: "gamma, used recently" }));
    expect(useWorkspaces.getState().activeId).toBe("c");
    expect(useUi.getState().centerMode.c).toBe("board");
    // alpha, just left, is now the recent one; gamma, current, is not listed.
    expect(rowNames()).toEqual(["alpha, used recently"]);
  });

  it("one cap of five: stateful rows win the slots, the rest are 'N more workspaces'", async () => {
    const many = Array.from({ length: 9 }, (_, i) => ws(`w${i}`, `ws ${i}`, 100 - i));
    const t = Date.now();
    const stamps: Record<string, number> = {};
    for (const w of many) stamps[w.id] = t - Number(w.id.slice(1)) * 1_000;
    act(() => {
      seedTiles({
        w6: [workingTile("w6-t", "w6", "claude")],
        w7: [workingTile("w7-t", "w7", "claude")],
        w8: [workingTile("w8-t", "w8", "claude")],
      });
      useUi.setState({ workspaceActiveAt: stamps });
    });
    await renderWith(many, "w0");
    expect(rowNames()).toEqual([
      "ws 6, 1 working",
      "ws 7, 1 working",
      "ws 8, 1 working",
      "ws 1, used recently",
      "ws 2, used recently",
    ]);
    // ws 3, 4 and 5 are recent too, but out of slots.
    expect(within(stack()).getByRole("button", { name: "3 more workspaces" })).toBeTruthy();
    expect(within(stack()).queryByRole("button", { name: /more active/ })).toBeNull();
  });

  it("a recent workspace that starts working shows it in place, then moves up once the order holds", async () => {
    tauri().allowUnhandled();
    tauri().fixture("drain_status", { draining: false, startedAt: null });
    tauri().fixture("ship_pending_count", 0);
    tauri().fixture("ship_pending_cards", null);
    tauri().fixture("ship_unverified_count", 0);
    const t = Date.now();
    act(() => {
      useInbox.setState({
        feed: feed([
          { workspaceId: "d", workspaceName: "delta", cardId: "k1", title: "Rollback tests" },
        ]),
      });
      useUi.setState({ workspaceActiveAt: { b: t - 1_000, c: t - 2_000 } });
      useWorkspaces.setState({ workspaces: WS, activeId: "a" });
    });
    renderUi(<WorkspaceSidebar env={null} />, { fakeTimers: true });
    expect(rowNames()).toEqual([
      "delta, 1 needs you",
      "beta, used recently",
      "gamma, used recently",
    ]);
    // The person is on gamma's row when its card starts building (the feed's
    // running row, a cold workspace).
    const gammaRow = within(stack()).getByRole("button", { name: "gamma, used recently" });
    act(() => gammaRow.focus());
    act(() => {
      useInbox.setState({
        feed: feed([
          { workspaceId: "d", workspaceName: "delta", cardId: "k1", title: "Rollback tests" },
          {
            workspaceId: "c",
            workspaceName: "gamma",
            cardId: "k2",
            title: "Docs",
            group: "running",
            kind: "card_running",
            seenEligible: false,
          },
        ]),
      });
    });
    // Its state at once, where it was…
    expect(rowNames()).toEqual([
      "delta, 1 needs you",
      "beta, used recently",
      "gamma, 1 working",
    ]);
    // The same button, still focused, now with its state.
    expect(document.activeElement).toBe(gammaRow);
    expect(gammaRow.getAttribute("aria-label")).toBe("gamma, 1 working");
    // Still there after a couple of the clock's ticks…
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(rowNames()[2]).toBe("gamma, 1 working");
    act(() => {
      vi.advanceTimersByTime(REORDER_HOLD_MS);
    });
    // …then up into the stateful group.
    expect(rowNames()).toEqual([
      "delta, 1 needs you",
      "gamma, 1 working",
      "beta, used recently",
    ]);
  });

  it("a workspace that goes idle stays in place, focus kept, then joins the recent rows once the order holds", async () => {
    tauri().allowUnhandled();
    tauri().fixture("drain_status", { draining: false, startedAt: null });
    tauri().fixture("ship_pending_count", 0);
    tauri().fixture("ship_pending_cards", null);
    tauri().fixture("ship_unverified_count", 0);
    const t = Date.now();
    act(() => {
      useInbox.setState({
        feed: feed([
          {
            workspaceId: "d",
            workspaceName: "delta",
            cardId: "k1",
            title: "Docs",
            group: "running",
            kind: "card_running",
            seenEligible: false,
          },
        ]),
      });
      useUi.setState({ workspaceActiveAt: { b: t - 1_000, c: t - 2_000, d: t - 3_000 } });
      useWorkspaces.setState({ workspaces: WS, activeId: "a" });
    });
    renderUi(<WorkspaceSidebar env={null} />, { fakeTimers: true });
    expect(rowNames()).toEqual(["delta, 1 working", "beta, used recently", "gamma, used recently"]);
    const deltaRow = within(stack()).getByRole("button", { name: "delta, 1 working" });
    act(() => deltaRow.focus());
    // Its build ends: nothing going on in delta any more.
    act(() => useInbox.setState({ feed: feed([]) }));
    expect(rowNames()).toEqual(["delta, used recently", "beta, used recently", "gamma, used recently"]);
    expect(document.activeElement).toBe(deltaRow);
    expect(within(stack()).queryByRole("button", { name: /going on in delta/ })).toBeNull();
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(rowNames()[0]).toBe("delta, used recently");
    act(() => {
      vi.advanceTimersByTime(REORDER_HOLD_MS);
    });
    // Among the recent rows by when it was last active: the oldest, last.
    expect(rowNames()).toEqual(["beta, used recently", "gamma, used recently", "delta, used recently"]);
  });

  it("a row going idle with the focus on its chevron or an item hands the focus to its name", async () => {
    const t = Date.now();
    const running = (cardId: string) => ({
      workspaceId: "d",
      workspaceName: "delta",
      cardId,
      title: "Docs",
      group: "running" as const,
      kind: "card_running" as const,
      seenEligible: false,
    });
    act(() => {
      useInbox.setState({ feed: feed([running("k1")]) });
      useUi.setState({ workspaceActiveAt: { d: t - 1_000 } });
    });
    const r = await renderWith(WS, "a");
    // The chevron.
    const chevron = within(stack()).getByRole("button", { name: "Show what is going on in delta" });
    act(() => chevron.focus());
    act(() => useInbox.setState({ feed: feed([]) }));
    const name = within(stack()).getByRole("button", { name: "delta, used recently" });
    expect(document.activeElement).toBe(name);
    // An item of its expanded list.
    act(() => useInbox.setState({ feed: feed([running("k2")]) }));
    await r.user.click(within(stack()).getByRole("button", { name: "Show what is going on in delta" }));
    const item = within(within(stack()).getByRole("list", { name: "In delta" })).getByRole("button");
    act(() => item.focus());
    act(() => useInbox.setState({ feed: feed([]) }));
    expect(document.activeElement).toBe(
      within(stack()).getByRole("button", { name: "delta, used recently" }),
    );
    // Focus elsewhere is left alone.
    act(() => useInbox.setState({ feed: feed([running("k3")]) }));
    const outside = screen.getByRole("button", { name: /switch workspace/ });
    act(() => outside.focus());
    act(() => useInbox.setState({ feed: feed([]) }));
    expect(document.activeElement).toBe(outside);
  });

  it("switching from a recent row: the one left joins at the top, the one entered leaves, at once", async () => {
    const t = Date.now();
    act(() => useUi.setState({ workspaceActiveAt: { b: t - 1_000, c: t - 2_000 } }));
    const r = await renderWith(WS, "a");
    expect(rowNames()).toEqual(["beta, used recently", "gamma, used recently"]);
    await r.user.click(within(stack()).getByRole("button", { name: "gamma, used recently" }));
    expect(useWorkspaces.getState().activeId).toBe("c");
    expect(rowNames()).toEqual(["alpha, used recently", "beta, used recently"]);
  });

  it("seven with a state and two recent: five rows, 'N more active' shows all seven, the recent ones wait", async () => {
    const many = Array.from({ length: 10 }, (_, i) => ws(`w${i}`, `ws ${i}`, 100 - i));
    const t = Date.now();
    const stamps: Record<string, number> = {};
    for (const w of many) stamps[w.id] = t - Number(w.id.slice(1)) * 1_000;
    const tiles: Record<string, Tile[]> = {};
    // w1–w7 work; w8 and w9 were used this session and are idle.
    for (const w of many.slice(1, 8)) tiles[w.id] = [workingTile(`${w.id}-t`, w.id, "claude")];
    act(() => {
      seedTiles(tiles);
      useUi.setState({ workspaceActiveAt: stamps });
    });
    const r = await renderWith(many, "w0");
    expect(rowNames()).toHaveLength(5);
    expect(rowNames().every((n) => n?.endsWith("1 working"))).toBe(true);
    expect(within(stack()).getByRole("button", { name: "2 more workspaces" })).toBeTruthy();
    await r.user.click(within(stack()).getByRole("button", { name: "2 more active" }));
    expect(rowNames()).toHaveLength(7);
    expect(rowNames().some((n) => n?.endsWith("used recently"))).toBe(false);
    expect(within(stack()).getByRole("button", { name: "2 more workspaces" })).toBeTruthy();
    await r.user.click(within(stack()).getByRole("button", { name: "Show fewer" }));
    expect(rowNames()).toHaveLength(5);
  });

  it("draws nothing with one workspace", async () => {
    await renderWith([ws("a", "alpha", 1)], "a");
    expect(screen.queryByRole("region", { name: "Other workspaces" })).toBeNull();
  });
});
