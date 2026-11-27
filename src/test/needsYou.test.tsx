// UX-4.4: one attention signal. A Claude session idle at its prompt is an
// Inbox "Needs you" row ("Claude · Asks you something", Open session),
// and the sidebar's Inbox count is the one number — the switcher's
// per-workspace counts are the same sum, split.
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { InboxPanel } from "../components/InboxPanel";
import { WorkspaceSidebar } from "../components/WorkspaceSidebar";
import { useWorkspaces, type Workspace } from "../store/workspaceStore";
import { useTiles, type Tile } from "../store/tileStore";
import { useInbox } from "../store/inboxStore";
import { useTileSeen } from "../store/tileSeenStore";
import { useUi } from "../store/uiStore";
import { dropEndedBuilderSessions, useBuilder } from "../store/builderStore";
import { useKanban } from "../store/kanbanStore";
import { RESIZE_REDRAW_MS } from "../lib/attention";
import { attentionCounts, liveSessionPty, needsYouByWorkspace, sumCounts, waitingSessions } from "../lib/needsYou";
import { INBOX_EMPTY_TITLE } from "../lib/inboxView";
import type { InboxEvent, InboxFeed, KanbanCard } from "../ipc";
import { act, nextFrame, renderUi, screen, tauri, within } from "./render";

// N18: the Inbox page also reads the card-branch cleanup's questions.
beforeEach(() => tauri().fixture("branch_cleanup_pending", []));

const NOW = Date.now();

function ws(id: string, name: string, lastOpenedAt: number): Workspace {
  return { id, name, cwd: `/code/${name}`, createdAt: 1, lastOpenedAt, openFiles: [], activeFile: null };
}

function claudeTile(id: string, label: string, over: Partial<Tile> = {}): Tile {
  return {
    id,
    workspaceId: "a",
    kind: "claude",
    ptyId: `pty-${id}`,
    label,
    cwd: "/code/alpha",
    startedAt: NOW - 120_000,
    status: "running",
    pendingClose: false,
    expanded: false,
    lastOutputAt: NOW - 60_000,
    promptBoxIdle: true,
    // QoL 1.168 (D7): back at Ready after a turn — a fresh tile nobody typed
    // into does not wait for anyone.
    readiness: { lastOutputAt: NOW - 60_000, matcherIdle: true, leftReadyAt: NOW - 90_000 },
    // QoL 1.168 (Windows walk): the member's line that turn answered.
    submittedAt: NOW - 90_000,
    ...over,
  };
}

// 1.173.0 (F1): a failure is a Needs you row of its own kind.
function ev(id: string, workspaceId: string, group: InboxEvent["group"] | "failure"): InboxEvent {
  return {
    id,
    kind: group === "failure" ? "card_failed" : "review_needed",
    group: group === "failure" ? "needs_you" : group,
    workspaceId,
    workspaceName: workspaceId === "a" ? "alpha" : "beta",
    cardId: `card-${id}`,
    runId: null,
    title: `Card ${id}`,
    detail: null,
    url: null,
    at: NOW - 60_000,
    seenAt: null,
    seenEligible: true,
  };
}

const FEED: InboxFeed = {
  generatedAt: NOW,
  windowDays: 28,
  events: [ev("r1", "a", "needs_you"), ev("f1", "b", "failure")],
  costRollup: [],
  eligibilityProof: {} as InboxFeed["eligibilityProof"],
};

function seed() {
  act(() => {
    useWorkspaces.setState({ workspaces: [ws("a", "alpha", 10), ws("b", "beta", 5)], activeId: "a" });
    useTiles.setState({
      byWorkspace: {
        a: {
          tiles: [
            claudeTile("t1", "Rename the tile header"),
            // Still working: printed a second ago.
            claudeTile("t2", "Busy one", { lastOutputAt: Date.now() }),
            // A plain shell never waits for anyone.
            claudeTile("t3", "zsh", { kind: "shell" }),
          ],
          expandedTileId: null,
          detailTileId: null,
        },
      },
    });
    useInbox.setState({ feed: FEED, proofReady: true });
  });
}

function sectionCountOf(title: string): string | null {
  const head = screen.getByRole("heading", { name: title }).closest(".ux-section-head") as HTMLElement;
  return head.querySelector(".ux-section-count")?.textContent ?? null;
}

describe("one attention signal", () => {
  it("lists an idle Claude tile as Needs you, and Open session focuses the tile", async () => {
    seed();
    const r = renderUi(<InboxPanel />, { fixtures: { inbox_feed: FEED } });
    const needs = await screen.findByRole("group", { name: "Needs you" });
    const title = within(needs).getByText("Claude finished · see what it did");
    const row = title.closest(".ux-row") as HTMLElement;
    expect(within(row).getByText("In “Rename the tile header”")).toBeTruthy();
    expect(within(row).getByText("alpha")).toBeTruthy();
    // Only the idle Claude tile waits; the busy one and the shell do not.
    expect(within(needs).getAllByText("Claude finished · see what it did")).toHaveLength(1);
    // F1: a failure is a Needs you row; one sentence, one count.
    expect(screen.getByText("3 things need you.")).toBeTruthy();

    await r.user.click(within(row).getByRole("button", { name: "Open session" }));
    expect(useUi.getState().centerMode.a).toBe("terminals");
    expect(useTiles.getState().byWorkspace.a.expandedTileId).toBe("t1");
  });

  it("counts the sidebar's Inbox and the switcher from the same sum", async () => {
    seed();
    tauri().allowUnhandled();
    tauri().fixture("drain_status", { draining: false, startedAt: null });
    tauri().fixture("ship_pending_count", 0);
    tauri().fixture("ship_pending_cards", null);
    tauri().fixture("ship_unverified_count", 0);
    const r = renderUi(<WorkspaceSidebar env={null} />);
    await nextFrame();
    // alpha: one unseen review + one waiting tile; beta: one unseen failure.
    const inbox = screen.getByRole("button", { name: /^Inbox/ });
    expect(within(inbox).getByText("3")).toBeTruthy();
    // GH #286: the trigger has no number (it read as alpha's own); it says
    // in its name that another workspace waits, and draws a dot.
    const trigger = screen.getByRole("button", { name: /switch workspace/ });
    expect(trigger.getAttribute("aria-label")).toBe(
      "alpha, switch workspace, other workspaces need you",
    );
    expect(trigger.textContent).not.toMatch(/\d/);
    expect(trigger.querySelector(".shell-switcher-elsewhere")).toBeTruthy();
    await r.user.click(trigger);
    await nextFrame();
    const pop = screen.getByRole("dialog", { name: "Workspaces" });
    const a = within(pop).getByRole("button", { name: "alpha, 2 need you" });
    const b = within(pop).getByRole("button", { name: "beta, 1 needs you" });
    expect(a && b).toBeTruthy();
  });

  // GH #104 walk 2: the sidebar said 23 while the page said "26 things need
  // you". 1.173.0 (F1, BI-14, BI-15): one count — a to-do row counts until it
  // is resolved, seen or not, on the sidebar, the sentence and Needs you.
  it("says on the page the count the sidebar shows, seen to-do rows counted in both", async () => {
    seed();
    const feed: InboxFeed = {
      ...FEED,
      events: [
        ...FEED.events,
        { ...ev("r2", "a", "needs_you"), seenAt: NOW - 1000 },
        { ...ev("r3", "b", "needs_you"), seenAt: NOW - 1000 },
        { ...ev("f2", "a", "failure"), seenAt: NOW - 1000 },
        { ...ev("r4", "b", "needs_you"), seenEligible: false },
      ],
    };
    act(() => useInbox.setState({ feed }));
    tauri().allowUnhandled();
    tauri().fixture("inbox_feed", feed);
    tauri().fixture("drain_status", { draining: false, startedAt: null });
    tauri().fixture("ship_pending_count", 0);
    tauri().fixture("ship_pending_cards", null);
    tauri().fixture("ship_unverified_count", 0);
    renderUi(
      <>
        <WorkspaceSidebar env={null} />
        <InboxPanel />
      </>,
    );
    await nextFrame();
    // To do: r1, f1, r2, r3, f2 (seen or not); waiting: tile t1. r4 takes
    // no marker and counts nowhere.
    const inbox = screen.getByRole("button", { name: /^Inbox/ });
    expect(within(inbox).getByText("6")).toBeTruthy();
    expect(await screen.findByText("6 things need you.")).toBeTruthy();
    const needs = screen.getByRole("group", { name: "Needs you" });
    // A seen to-do row is not greyed, and a failure is in Needs you, first
    // among the feed's rows.
    const r2 = within(needs).getByText("Card r2").closest(".ux-row")!;
    expect(r2.classList.contains("ux-row--muted")).toBe(false);
    expect(within(needs).getByText("Card f1")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Failed" })).toBeNull();
    const counts = attentionCounts(feed, [{ id: "tile:t1", workspaceId: "a", agent: "Claude", where: "x", since: 0, target: { kind: "tile", tileId: "t1" } }]);
    expect(counts).toEqual({ byWorkspace: { a: 4, b: 2 }, total: 6, needs: 6 });
    // N18: the card-branch cleanup's questions count as needing you.
    expect(
      attentionCounts(feed, [{ id: "tile:t1", workspaceId: "a", agent: "Claude", where: "x", since: 0, target: { kind: "tile", tileId: "t1" } }], { b: 2 }),
    ).toEqual({ byWorkspace: { a: 4, b: 4 }, total: 8, needs: 8 });
    // PR #347 walk: the section header says the same number.
    expect(sectionCountOf("Needs you")).toBe(String(counts.needs));
  });

  it("F1: Clear the news takes only the news; what needs you stays and is counted", async () => {
    seed();
    const merged: InboxEvent = { ...ev("ship:c7:abc", "a", "shipped"), kind: "pr_merged", detail: "#382", title: "Pricing page" };
    const feed: InboxFeed = { ...FEED, events: [...FEED.events, merged] };
    act(() => useInbox.setState({ feed, proofReady: true }));
    tauri().allowUnhandled();
    tauri().fixture("inbox_mark_seen", 1);
    const r = renderUi(<InboxPanel />, { fixtures: { inbox_feed: feed } });
    const news = await screen.findByRole("group", { name: "News" });
    expect(within(news).getByText("Pricing page")).toBeTruthy();
    expect(within(news).getByText("Pull request #382 merged")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Mark all seen" })).toBeNull();
    // News has no number: it asks nothing.
    expect(sectionCountOf("News")).toBeNull();
    tauri().fixture("inbox_feed", { ...feed, events: [...FEED.events, { ...merged, seenAt: NOW }] });
    await r.user.click(screen.getByRole("button", { name: "Clear the news" }));
    expect(tauri().callsOf("inbox_mark_seen").map((c) => c.args.eventIds)).toEqual([["ship:c7:abc"]]);
    expect(screen.queryByRole("group", { name: "News" })).toBeNull();
    // The to-do rows stay, counted.
    expect(within(screen.getByRole("group", { name: "Needs you" })).getByText("Card r1")).toBeTruthy();
    expect(sectionCountOf("Needs you")).toBe("3");
  });

  // 1.174.0 (A5, P10, D4 b; inbox.html scenes 3, 4): a round's ideas are
  // News — never counted — "New · " until seen; Clear the news greys the
  // row and keeps it, "Seen · waiting for your answer".
  it("A5: the ideas row is News, never counted, and Clear the news greys it", async () => {
    seed();
    const ideas: InboxEvent = {
      ...ev("next-improvement:a:site:r1", "a", "news"),
      kind: "next_improvement_ideas",
      cardId: null,
      title: "Next improvement for Site: 2 ideas",
      detail: "Claude proposed, Codex gave a second opinion",
    };
    const feed: InboxFeed = { ...FEED, events: [...FEED.events, ideas] };
    act(() => useInbox.setState({ feed, proofReady: true }));
    tauri().allowUnhandled();
    tauri().fixture("inbox_mark_seen", 1);
    const r = renderUi(<InboxPanel />, { fixtures: { inbox_feed: feed } });
    const news = await screen.findByRole("group", { name: "News" });
    const row = within(news).getByText("Next improvement for Site: 2 ideas").closest(".ux-row")!;
    expect(row.classList.contains("ux-row--muted")).toBe(false);
    expect(within(news).getByText("New · Claude proposed, Codex gave a second opinion")).toBeTruthy();
    // Not counted: the Needs you number is the cards' alone.
    expect(sectionCountOf("Needs you")).toBe("3");
    expect(attentionCounts(feed, []).needs).toBe(attentionCounts(FEED, []).needs);
    tauri().fixture("inbox_feed", { ...feed, events: [...FEED.events, { ...ideas, seenAt: NOW }] });
    await r.user.click(screen.getByRole("button", { name: "Clear the news" }));
    expect(tauri().callsOf("inbox_mark_seen").map((c) => c.args.eventIds)).toEqual([["next-improvement:a:site:r1"]]);
    const kept = (await screen.findByText("Seen · waiting for your answer")).closest(".ux-row")!;
    expect(kept.classList.contains("ux-row--muted")).toBe(true);
    expect(within(kept as HTMLElement).getByRole("button", { name: "Look at the ideas" })).toBeTruthy();
    // Nothing new to clear: the press goes.
    expect(screen.queryByRole("button", { name: "Clear the news" })).toBeNull();
    expect(sectionCountOf("Needs you")).toBe("3");
  });

  // 1.173.0 (F1): a tile's finished turn is to do until it is opened (D7);
  // Clear the news leaves it, and there is no Mark all seen.
  it("QoL 1.168 (D7): a tile's finished turn is counted until opened; a fresh tile is not listed", async () => {
    seed();
    act(() =>
      useTiles.setState({
        byWorkspace: {
          a: {
            tiles: [
              claudeTile("t1", "Rename the tile header"),
              claudeTile("t4", "Never typed into", { readiness: { lastOutputAt: NOW - 60_000, matcherIdle: true, leftReadyAt: NOW - 90_000 }, submittedAt: undefined }),
            ],
            expandedTileId: null,
            detailTileId: null,
          },
        },
      }),
    );
    const empty: InboxFeed = { ...FEED, events: [] };
    act(() => useInbox.setState({ feed: empty, proofReady: true }));
    const r = renderUi(<InboxPanel />, { fixtures: { inbox_feed: empty } });
    expect(await screen.findByText("1 thing needs you.")).toBeTruthy();
    expect(screen.queryByText("In “Never typed into”")).toBeNull();
    expect(screen.queryByRole("button", { name: "Mark all seen" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Clear the news" })).toBeNull();
    // Opening it is seeing it: the row leaves the list.
    await r.user.click(screen.getByRole("button", { name: "Open session" }));
    expect(await screen.findByText(INBOX_EMPTY_TITLE)).toBeTruthy();
    expect(screen.queryByText("In “Rename the tile header”")).toBeNull();
    act(() => useTileSeen.setState({ seen: {} }));
  });

  // 1.173.0 (F1, BI-14): seen is not resolved — a to-do row keeps counting.
  it("keeps a feed item in the count once seen, as a waiting session", () => {
    const waiting = waitingSessions({
      tilesByWorkspace: { a: { tiles: [claudeTile("t1", "x")] } },
      builders: {
        c9: { workspaceId: "b", vendor: "codex", startedAt: NOW - 90_000, promptBoxIdle: true },
      },
      cardTitle: (_ws, id) => (id === "c9" ? "Stripe webhooks" : null),
      now: NOW,
    });
    expect(waiting.map((s) => [s.id, s.agent, s.where])).toEqual([
      ["builder:c9", "Codex", "Stripe webhooks"],
      ["tile:t1", "Claude", "x"],
    ]);
    const seen: InboxFeed = { ...FEED, events: FEED.events.map((e) => ({ ...e, seenAt: NOW })) };
    expect(needsYouByWorkspace(seen, waiting)).toEqual({ a: 2, b: 2 });
    expect(sumCounts(needsYouByWorkspace(FEED, waiting))).toBe(4);
  });
});

// The count must not flicker when the window is resized: xterm's resize makes
// the TUI redraw, and that redraw is PTY output. It is not activity.
describe("a resize's redraw", () => {
  afterEach(() => {
    vi.useRealTimers();
    act(() => {
      useTiles.setState({ byWorkspace: {} });
      useBuilder.setState({ byCard: {} });
    });
  });

  function counts(now: number) {
    return needsYouByWorkspace(
      null,
      waitingSessions({
        tilesByWorkspace: useTiles.getState().byWorkspace,
        builders: useBuilder.getState().byCard,
        cardTitle: () => "a card",
        now,
      }),
    );
  }

  it("keeps a waiting session waiting, while real output after it still means working", () => {
    vi.useFakeTimers();
    const t0 = NOW + 1_000_000;
    vi.setSystemTime(t0);
    act(() =>
      useTiles.setState({
        byWorkspace: {
          a: {
            tiles: [claudeTile("t1", "api", { lastOutputAt: t0 - 60_000 })],
            expandedTileId: null,
            detailTileId: null,
          },
        },
      }),
    );
    expect(counts(t0)).toEqual({ a: 1 });

    // The window is resized; the TUI redraws in bursts over the next moment.
    act(() => useTiles.getState().noteResize("pty-t1"));
    for (const dt of [20, 300, RESIZE_REDRAW_MS - 10]) {
      vi.setSystemTime(t0 + dt);
      act(() => useTiles.getState().markOutput("pty-t1"));
      expect(counts(t0 + dt)).toEqual({ a: 1 });
    }
    expect(useTiles.getState().byWorkspace.a.tiles[0].lastOutputAt).toBe(t0 - 60_000);
    // Moments later it still waits — no dip to working for ten seconds.
    expect(counts(t0 + 5_000)).toEqual({ a: 1 });

    // The person answers and Claude works: output after the window counts.
    vi.setSystemTime(t0 + 20_000);
    act(() => useTiles.getState().markOutput("pty-t1"));
    expect(useTiles.getState().byWorkspace.a.tiles[0].lastOutputAt).toBe(t0 + 20_000);
    expect(counts(t0 + 20_500)).toEqual({});
  });

  it("does the same for a card's Builder", () => {
    vi.useFakeTimers();
    const t0 = NOW + 2_000_000;
    vi.setSystemTime(t0);
    act(() =>
      useBuilder.setState({
        byCard: {
          c1: {
            workspaceId: "b",
            ptyId: "pty-c1",
            vendor: "claude",
            startedAt: t0 - 120_000,
            lastOutputAt: t0 - 60_000,
            promptBoxIdle: true,
            pending: [],
          },
        },
      }),
    );
    expect(counts(t0)).toEqual({ b: 1 });
    act(() => useBuilder.getState().noteResize("c1"));
    vi.setSystemTime(t0 + 100);
    act(() => useBuilder.getState().markOutput("c1"));
    expect(counts(t0 + 5_000)).toEqual({ b: 1 });
    expect(useBuilder.getState().byCard.c1.lastOutputAt).toBe(t0 - 60_000);

    vi.setSystemTime(t0 + RESIZE_REDRAW_MS + 100);
    act(() => useBuilder.getState().markOutput("c1"));
    expect(counts(t0 + RESIZE_REDRAW_MS + 200)).toEqual({});
  });
});

// Round 3 (challenger M1): the count follows what the card says. A Builder
// whose build is done and that is only idle, and the two builds of a card
// waiting for its pick, are not "waiting for your answer".
describe("sessions whose card already says what it waits on", () => {
  const snapshot = { n: 1, sha: "s", at: NOW - 60_000 };
  const doneCard = {
    id: "c1",
    workspaceId: "a",
    title: "Ready card",
    columnId: "in_progress",
    createdAt: 1,
    updatedAt: 1,
    lastRunStatus: "success",
    builder: { vendor: "claude", bypass: false, ptyId: "p1", sessionLost: false, startedAt: 1, snapshots: [snapshot] },
  } as unknown as KanbanCard;
  const idle = { workspaceId: "a", vendor: "claude" as const, startedAt: NOW - 120_000, lastOutputAt: NOW - 90_000, promptBoxIdle: true };

  it("(A) a Ready-to-ship Builder idle at its prompt is not waiting; a real question is", () => {
    const run = (turnIdle: boolean, sentAt?: number) =>
      waitingSessions({
        tilesByWorkspace: {},
        builders: { c1: { ...idle, turnIdle } },
        cardTitle: () => "Ready card",
        now: NOW,
        card: () => doneCard,
        sentAt: sentAt ? { c1: sentAt } : {},
        doneAt: {},
      }).map((s) => s.id);
    expect(run(true)).toEqual([]);
    // Its turn is not over at the prompt: a question or a permission prompt.
    expect(run(false)).toEqual(["builder:c1"]);
    // Something was sent after the build: its prompt is an answer it waits for.
    expect(run(true, NOW - 30_000)).toEqual(["builder:c1"]);
  });

  it("(B) a card built by both waiting for the pick counts once, not three times", () => {
    const lane = (id: "a" | "b") => ({
      lane: id,
      vendor: id === "a" ? "claude" : "codex",
      worktreePath: "/w",
      branchName: "b",
      startedAt: 1,
      ptyId: `p${id}`,
      done: { sha: "s", at: 2 },
    });
    const bothCard = {
      ...doneCard,
      id: "c2",
      builder: null,
      lastRunStatus: "running",
      buildBoth: { startedAt: 1, lanes: [lane("a"), lane("b")], compare: { status: "done", recommended: "a", reasons: [], startedAt: 3, at: 4 } },
    } as unknown as KanbanCard;
    const waiting = waitingSessions({
      tilesByWorkspace: {},
      builders: { "c2#both-a": { ...idle, turnIdle: true }, "c2#both-b": { ...idle, vendor: "codex", turnIdle: true } },
      cardTitle: () => "Both card",
      now: NOW,
      card: () => bothCard,
    });
    expect(waiting).toEqual([]);
    const pickRow: InboxEvent = {
      id: "pick:c2:3",
      kind: "card_running",
      group: "needs_you",
      workspaceId: "a",
      workspaceName: "alpha",
      cardId: "c2",
      runId: null,
      title: "Both card",
      detail: "Pick one of the two builds",
      url: null,
      at: NOW,
      seenAt: null,
      seenEligible: true,
    };
    const feed: InboxFeed = { ...FEED, events: [pickRow] };
    expect(sumCounts(needsYouByWorkspace(feed, waiting))).toBe(1);
  });
});

// PR #347 walk: a card's Builder waited at Claude's question, then the person
// closed the session. The Inbox kept "Claude · Asks you something" for
// a session that no longer existed, beside the card's "Session closed".
describe("a closed Builder session", () => {
  afterEach(() => {
    act(() => {
      useBuilder.setState({ byCard: {} });
      useKanban.setState({ byWorkspace: {} });
      useTiles.setState({ byWorkspace: {} });
    });
    // Forget what the last test saw gone.
    dropEndedBuilderSessions();
  });

  const card = (ptyId: string | null) =>
    ({
      id: "c1",
      workspaceId: "a",
      title: "Attach check 1",
      columnId: "in_progress",
      createdAt: 1,
      updatedAt: 1,
      lastRunStatus: "running",
      builder: { vendor: "claude", bypass: false, ptyId, sessionLost: false, startedAt: 1, snapshots: [] },
    }) as unknown as KanbanCard;

  function seedWaiting(ptyId: string | null) {
    act(() => {
      useWorkspaces.setState({ workspaces: [ws("a", "alpha", 10)], activeId: "a" });
      useInbox.setState({ feed: { ...FEED, events: [] }, proofReady: true });
      useKanban.setState({ byWorkspace: { a: { cards: [card(ptyId)], loaded: true } } });
      useBuilder.setState({
        byCard: {
          c1: {
            workspaceId: "a",
            ptyId: "pty-c1",
            vendor: "claude",
            startedAt: NOW - 120_000,
            lastOutputAt: NOW - 60_000,
            promptBoxIdle: true,
            pending: [],
          },
        },
      });
    });
  }

  it("is a waiting row while it waits, and none once it is closed", async () => {
    seedWaiting("pty-c1");
    renderUi(<InboxPanel />, { fixtures: { inbox_feed: { ...FEED, events: [] } } });
    const needs = await screen.findByRole("group", { name: "Needs you" });
    // F1 (BI-11): the card's row is its Board card — title and headline.
    expect(within(needs).getByText("Attach check 1")).toBeTruthy();
    expect(within(needs).getByText("Asks you something")).toBeTruthy();
    expect(sectionCountOf("Needs you")).toBe("1");

    // Closed: the backend cleared the card's session; the terminal that
    // would have dropped the runtime on the PTY's exit was not mounted.
    act(() => useKanban.setState({ byWorkspace: { a: { cards: [card(null)], loaded: true } } }));
    await nextFrame();
    expect(screen.queryByText("Asks you something")).toBeNull();
    expect(screen.queryByRole("group", { name: "Needs you" })).toBeNull();
  });

  it("drops the runtime of a closed or replaced session on two ticks, not of a live one", () => {
    seedWaiting("pty-c1");
    expect(dropEndedBuilderSessions()).toEqual([]);
    expect(useBuilder.getState().byCard.c1).toBeTruthy();
    // A board that is not loaded judges nothing.
    act(() => useKanban.setState({ byWorkspace: {} }));
    expect(dropEndedBuilderSessions()).toEqual([]);
    expect(dropEndedBuilderSessions()).toEqual([]);
    // Resumed on another PTY: the old runtime goes on the second tick.
    act(() => useKanban.setState({ byWorkspace: { a: { cards: [card("pty-new")], loaded: true } } }));
    expect(dropEndedBuilderSessions()).toEqual([]);
    expect(dropEndedBuilderSessions()).toEqual(["c1"]);
    expect(useBuilder.getState().byCard.c1).toBeUndefined();
    // Closed from the card: at once for that card.
    seedWaiting(null);
    expect(dropEndedBuilderSessions("c1")).toEqual(["c1"]);
    const waiting = waitingSessions({
      tilesByWorkspace: {},
      builders: useBuilder.getState().byCard,
      cardTitle: () => "Attach check 1",
      now: NOW,
    });
    expect(attentionCounts(null, waiting).total).toBe(0);
  });

  // Challenger minor: two forced reloads resolving out of order show the
  // card without its session for a moment; its held messages must survive.
  it("keeps a runtime a stale board read shows without its session for one tick", () => {
    seedWaiting("pty-c1");
    act(() => useBuilder.setState((s) => ({ byCard: { c1: { ...s.byCard.c1, pending: ["held"] } } })));
    act(() => useKanban.setState({ byWorkspace: { a: { cards: [card(null)], loaded: true } } }));
    expect(dropEndedBuilderSessions()).toEqual([]);
    // The newer read lands: the session is there again.
    act(() => useKanban.setState({ byWorkspace: { a: { cards: [card("pty-c1")], loaded: true } } }));
    expect(dropEndedBuilderSessions()).toEqual([]);
    // One more stale moment does not add up with the first.
    act(() => useKanban.setState({ byWorkspace: { a: { cards: [card(null)], loaded: true } } }));
    expect(dropEndedBuilderSessions()).toEqual([]);
    expect(useBuilder.getState().byCard.c1.pending).toEqual(["held"]);
  });

  it("drops the runtime of a deleted card once its board is loaded", () => {
    seedWaiting("pty-c1");
    act(() => useKanban.setState({ byWorkspace: { a: { cards: [], loaded: false } } }));
    expect(dropEndedBuilderSessions()).toEqual([]);
    expect(dropEndedBuilderSessions()).toEqual([]);
    act(() => useKanban.setState({ byWorkspace: { a: { cards: [], loaded: true } } }));
    const rt = useBuilder.getState().byCard.c1;
    const run = (loaded: boolean) =>
      waitingSessions({ tilesByWorkspace: {}, builders: { c1: rt }, cardTitle: () => "x", now: NOW, card: () => null, loaded: () => loaded }).length;
    expect(run(false)).toBe(1);
    expect(run(true)).toBe(0);
    expect(dropEndedBuilderSessions()).toEqual([]);
    expect(dropEndedBuilderSessions()).toEqual(["c1"]);
  });

  it("judges a lane of a card built by both by its own session", () => {
    const lane = (id: "a" | "b", ptyId: string | null) => ({ lane: id, vendor: id === "a" ? "claude" : "codex", worktreePath: "/w", branchName: "b", startedAt: 1, ptyId });
    const both = { ...card(null), builder: null, buildBoth: { startedAt: 1, lanes: [lane("a", null), lane("b", "pty-b")] } } as unknown as KanbanCard;
    expect(liveSessionPty(both, "c1#both-a")).toBeNull();
    expect(liveSessionPty(both, "c1#both-b")).toBe("pty-b");
    const rt = (ptyId: string, vendor: "claude" | "codex") => ({ workspaceId: "a", ptyId, vendor, startedAt: NOW - 120_000, lastOutputAt: NOW - 60_000, promptBoxIdle: true, pending: [] });
    act(() => {
      useKanban.setState({ byWorkspace: { a: { cards: [both], loaded: true } } });
      useBuilder.setState({ byCard: { "c1#both-a": rt("pty-a", "claude"), "c1#both-b": rt("pty-b", "codex") } });
    });
    expect(dropEndedBuilderSessions()).toEqual([]);
    expect(dropEndedBuilderSessions()).toEqual(["c1#both-a"]);
    expect(Object.keys(useBuilder.getState().byCard)).toEqual(["c1#both-b"]);
  });

  it("is not counted even before its runtime is dropped", () => {
    const rt = { workspaceId: "a", ptyId: "pty-c1", vendor: "claude" as const, startedAt: NOW - 120_000, lastOutputAt: NOW - 60_000, promptBoxIdle: true };
    const run = (c: KanbanCard) =>
      waitingSessions({ tilesByWorkspace: {}, builders: { c1: rt }, cardTitle: () => "x", now: NOW, card: () => c }).length;
    expect(run(card("pty-c1"))).toBe(1);
    expect(run(card(null))).toBe(0);
    expect(run(card("pty-other"))).toBe(0);
  });
});
