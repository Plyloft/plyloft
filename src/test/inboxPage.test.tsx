// UX-4.2: the Inbox is a page — a sentence that sums it up, the groups that
// have something (never Shipped), one action a row, and one quiet line for
// this week's ships that opens History.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { InboxPanel } from "../components/InboxPanel";
import { useWorkspaces, type Workspace } from "../store/workspaceStore";
import { useUi } from "../store/uiStore";
import { useKanban } from "../store/kanbanStore";
import { useBoard } from "../store/boardStore";
import type { InboxEvent, InboxFeed } from "../ipc";
import { act, renderUi, screen, waitFor, within, tauri } from "./render";
import { latestToast } from "../store/toastStore";

// N18: the Inbox page also reads the card-branch cleanup's questions.
beforeEach(() => tauri().fixture("branch_cleanup_pending", []));

const NOW = Date.now();

const lyra: Workspace = {
  id: "l",
  name: "Lyra",
  cwd: "/Users/someone/code/lyra",
  createdAt: 1,
  lastOpenedAt: 1,
  openFiles: [],
  activeFile: null,
};

function ev(over: Partial<InboxEvent> & Pick<InboxEvent, "id" | "kind" | "group">): InboxEvent {
  return {
    workspaceId: "l",
    workspaceName: "Lyra",
    cardId: "c1",
    runId: null,
    title: "A card",
    detail: null,
    url: null,
    at: NOW - 4 * 60_000,
    seenAt: null,
    seenEligible: true,
    ...over,
  };
}

function feedOf(events: InboxEvent[]): InboxFeed {
  return {
    generatedAt: NOW,
    windowDays: 28,
    events,
    costRollup: [{ workspaceId: "l", workspaceName: "Lyra", totalUsd: 12.5, weeklyUsd: [0, 0, 0, 12.5] }],
    eligibilityProof: {} as InboxFeed["eligibilityProof"],
  };
}

function seedWorkspace() {
  act(() => useWorkspaces.setState({ workspaces: [lyra], activeId: "l" }));
}

describe("the Inbox page", () => {
  it("sums the page up, groups what needs you, and never lists a ship", async () => {
    seedWorkspace();
    renderUi(<InboxPanel />, {
      fixtures: {
        inbox_feed: feedOf([
          // One card, one row (F1): each row its own card.
          ev({ id: "r1", kind: "review_needed", group: "needs_you", title: "Fix login redirect", cardId: "c1" }),
          ev({ id: "r2", kind: "review_needed", group: "needs_you", title: "Stripe webhooks", cardId: "c2" }),
          ev({ id: "f1", kind: "verify_failed", group: "needs_you", title: "Rate-limit search", detail: "2 of 14", cardId: "c3" }),
          ev({ id: "g1", kind: "card_running", group: "running", title: "Dark mode", seenEligible: false }),
          ev({ id: "s1", kind: "shipped", group: "shipped", title: "Shipped card", detail: "1.2.3" }),
          ev({ id: "s2", kind: "shipped", group: "shipped", title: "Old ship", at: NOW - 20 * 86_400_000 }),
        ]),
      },
    });
    // 1.173.0 (F1): Failed folded into Needs you — the failure first.
    expect(await screen.findByText("3 things need you, 1 is working.")).toBeTruthy();
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(["Needs you", "Working"]);
    // One action a row, named for what it does; a running row has the chevron.
    const needs = screen.getByRole("group", { name: "Needs you" });
    expect(within(needs).getAllByRole("button").map((b) => b.textContent)).toEqual([
      "See what failed",
      "See the review",
      "See the review",
    ]);
    expect(within(needs).getByText("Checks failed · 2 of 14")).toBeTruthy();
    const running = screen.getByRole("group", { name: "Working" });
    // A5 (A0): a row with no action opens from its label, a real button.
    expect(within(running).getByRole("button", { name: /Dark mode/ })).toBeTruthy();
    // No Shipped group, no ship row, no cost footer.
    expect(screen.queryByText("Shipped card")).toBeNull();
    expect(screen.queryByText(/\$12\.50/)).toBeNull();
    // The workspace is a chip on the row.
    expect(within(needs).getAllByText("Lyra")).toHaveLength(3);
  });

  // 1.175.0 (D3): a card whose issue changed on GitHub and here asks which
  // version to keep — the row says so, and its press is Choose.
  it("a card whose issue changed on GitHub and here has a Needs you row with Choose", async () => {
    seedWorkspace();
    renderUi(<InboxPanel />, {
      fixtures: {
        inbox_feed: feedOf([
          ev({
            id: "edit:gh-issue-70",
            kind: "review_needed",
            group: "needs_you",
            title: "Onboarding: shorter welcome",
            detail: "The brief changed on GitHub · choose which version the card keeps",
            cardId: "gh-issue-70",
          }),
        ]),
      },
    });
    const needs = await screen.findByRole("group", { name: "Needs you" });
    expect(within(needs).getByText("The brief changed on GitHub · choose which version the card keeps")).toBeTruthy();
    expect(within(needs).getAllByRole("button").map((b) => b.textContent)).toEqual(["Choose"]);
  });

  // F1 (BI-13): the empty Inbox says so, and where to go.
  it("says nothing needs you when the feed is empty, offers the Board, and opens History from the ships line", async () => {
    seedWorkspace();
    const r = renderUi(<InboxPanel />, {
      fixtures: {
        inbox_feed: feedOf([
          ev({ id: "s1", kind: "shipped", group: "shipped" }),
          ev({ id: "s2", kind: "shipped", group: "shipped", cardId: "c2" }),
        ]),
      },
    });
    expect(await screen.findByText("Nothing needs you")).toBeTruthy();
    expect(screen.getByText("When a card needs a decision or a press, it shows up here and on the Board.")).toBeTruthy();
    expect(screen.queryAllByRole("heading", { level: 2 })).toHaveLength(0);
    await r.user.click(screen.getByRole("button", { name: "Go to the Board" }));
    expect(useUi.getState().centerMode.l).toBe("board");
    await r.user.click(screen.getByRole("button", { name: /2 shipped this week · History/ }));
    expect(useUi.getState().centerMode.l).toBe("activity");
  });

  it("caps a long group at 12 with Show all", async () => {
    seedWorkspace();
    const many = Array.from({ length: 130 }, (_, i) =>
      ev({ id: `f${i}`, kind: "card_failed", group: "needs_you", title: `Card ${i}`, detail: "failed", cardId: `c${i}` }),
    );
    const r = renderUi(<InboxPanel />, { fixtures: { inbox_feed: feedOf(many) } });
    await screen.findByText("130 things need you.");
    const failed = screen.getByRole("group", { name: "Needs you" });
    expect(within(failed).getAllByRole("button")).toHaveLength(12);
    await r.user.click(screen.getByRole("button", { name: "Show all 130" }));
    expect(within(failed).getAllByRole("button")).toHaveLength(130);
  });

  // 1.173.0 (F1, BI-14): a seen to-do row stays, never greyed, until resolved.
  it("keeps a seen row in place, not greyed, and opens its card from the action", async () => {
    seedWorkspace();
    const r = renderUi(<InboxPanel />, {
      fixtures: {
        inbox_feed: feedOf([
          ev({ id: "r1", kind: "review_needed", group: "needs_you", title: "Seen one", seenAt: NOW - 1000 }),
        ]),
      },
    });
    const title = await screen.findByText("Seen one");
    expect(title.closest(".ux-row")?.className).not.toContain("ux-row--muted");
    expect(screen.getByText("1 thing needs you.")).toBeTruthy();
    await r.user.click(screen.getByRole("button", { name: "See the review" }));
    await waitFor(() => expect(useUi.getState().selectedCardId.l).toBe("c1"));
  });

  // GH #310: the count sits beside the heading; a card the ship rule says can
  // ship offers Ship it — bordered, A5 (P16): no row is filled — which opens the Ship sheet
  // with that card; a card that cannot ship keeps Review.
  it("puts the count by the heading and offers Ship it only when the card can ship", async () => {
    seedWorkspace();
    const card = (id: string, over: Record<string, unknown> = {}) => ({
      id,
      workspaceId: "l",
      title: id,
      columnId: "complete",
      verifyStatus: "passed",
      shipStatus: "unshipped",
      worktreePath: `/tmp/${id}`,
      builder: "claude",
      createdAt: 1,
      updatedAt: 1,
      ...over,
    });
    act(() =>
      useKanban.setState({
        byWorkspace: {
          l: { cards: [card("ready"), card("merged", { reviewStatus: "merged" })] },
        },
      } as never),
    );
    const r = renderUi(<InboxPanel />, {
      fixtures: {
        inbox_feed: feedOf([
          ev({ id: "r1", kind: "review_needed", group: "needs_you", title: "Fix login redirect", cardId: "ready" }),
          ev({ id: "r2", kind: "review_needed", group: "needs_you", title: "Landed one", cardId: "merged" }),
        ]),
        inbox_mark_seen: null,
      },
    });
    await screen.findByText("2 things need you.");
    const head = screen.getByRole("heading", { level: 2, name: "Needs you" }).parentElement!;
    expect(head.className).toContain("ux-section-head--inline");
    expect(head.textContent).toBe("Needs you2");
    const needs = screen.getByRole("group", { name: "Needs you" });
    const ship = within(needs).getByRole("button", { name: "Ship it" });
    expect(ship.className).not.toContain("cbtn--accent");
    expect(document.querySelector(".ux-inbox .cbtn--accent")).toBeNull();
    expect(within(needs).getByText("Ready to ship · checks passed")).toBeTruthy();
    // A5 round 1 (owner): Ship it opens the Ship step, so the card itself is
    // ⋯'s last item, Open the card.
    expect(within(needs).getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual([
      "Ship it",
      "More for Fix login redirect",
      "See the review",
    ]);
    await r.user.click(within(needs).getByRole("button", { name: "More for Fix login redirect" }));
    expect(within(screen.getByRole("menu")).getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["Open the card"]);
    await r.user.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Open the card" }));
    await waitFor(() => expect(useUi.getState().selectedCardId.l).toBe("ready"));
    expect(useUi.getState().cardStep.ready).not.toBe("ship");
    await r.user.click(ship);
    // QoL 1.168 S1-4: Ship it ships this card — its own Ship step, never the
    // Release sheet.
    expect(useUi.getState().releaseSheet).toBeNull();
    await waitFor(() => expect(useUi.getState().selectedCardId.l).toBe("ready"));
    expect(useUi.getState().cardStep.ready).toBe("ship");
  });
});

// 1.173.0 (F1, BI-7): a card Plyloft's quit paused is On hold with Resume;
// two or more in a project are one row that opens the Board.
describe("On hold in the Inbox", () => {
  const paused = (id: string, title: string) =>
    ev({ id: `session-ended:${id}:5`, kind: "card_running", group: "on_hold", cardId: id, title, detail: "paused when Plyloft closed" });

  it("shows one paused card with Resume, not counted as needing you", async () => {
    seedWorkspace();
    const r = renderUi(<InboxPanel />, { fixtures: { inbox_feed: feedOf([paused("p1", "Glossary links")]), inbox_mark_seen: 1 } });
    expect(await screen.findByText("Nothing needs you, 1 on hold.")).toBeTruthy();
    const hold = screen.getByRole("group", { name: "On hold" });
    expect(within(hold).getByText("Glossary links")).toBeTruthy();
    expect(within(hold).getByText("Paused when Plyloft closed")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Needs you" })).toBeNull();
    await r.user.click(within(hold).getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(useUi.getState().selectedCardId.l).toBe("p1"));
  });

  it("groups two or more paused cards of a project into one row that opens the Board", async () => {
    seedWorkspace();
    const r = renderUi(<InboxPanel />, {
      fixtures: { inbox_feed: feedOf([paused("p1", "Glossary links"), paused("p2", "Pricing page"), paused("p3", "Search")]) },
    });
    const hold = await screen.findByRole("group", { name: "On hold" });
    expect(within(hold).getAllByText("3 cards paused when Plyloft closed")).toHaveLength(1);
    expect(within(hold).getByText("“Glossary links”, “Pricing page”, “Search” · Resume each on its card")).toBeTruthy();
    // Its number counts the cards, as the Board's On hold does.
    expect(sectionHead("On hold")).toBe("On hold3");
    expect(screen.getByText("Nothing needs you, 3 on hold.")).toBeTruthy();
    await r.user.click(within(hold).getByRole("button", { name: "Go to the Board" }));
    expect(useUi.getState().centerMode.l).toBe("board");
  });
});

describe("On hold and seen rows (F1, Reviewer 1 and 6)", () => {
  it("lists a queued card in On hold as its own row, never in a paused group", async () => {
    seedWorkspace();
    renderUi(<InboxPanel />, {
      fixtures: {
        inbox_feed: feedOf([
          ev({ id: "session-ended:p1:5", kind: "card_running", group: "on_hold", cardId: "p1", title: "Glossary links", detail: "paused when Plyloft closed" }),
          ev({ id: "queued:q1", kind: "card_queued", group: "on_hold", cardId: "q1", title: "Search", detail: "queued", seenEligible: false }),
          ev({ id: "queued:q2", kind: "card_queued", group: "on_hold", cardId: "q2", title: "Footer", detail: "queued", seenEligible: false }),
        ]),
      },
    });
    const hold = await screen.findByRole("group", { name: "On hold" });
    expect(within(hold).getByText("Glossary links")).toBeTruthy();
    expect(within(hold).getAllByText("In line for a free slot")).toHaveLength(2);
    expect(within(hold).queryByText(/cards paused when Plyloft closed/)).toBeNull();
    expect(screen.queryByRole("group", { name: "Working" })).toBeNull();
  });

  it("greys a seen row that has no card and leaves it out of the count; a card's seen row stays counted", async () => {
    seedWorkspace();
    renderUi(<InboxPanel />, {
      fixtures: {
        inbox_feed: feedOf([
          ev({ id: "plugin:x", kind: "team_plugin_refused", group: "needs_you", cardId: null, title: "A refused plugin", seenAt: NOW - 1000 }),
          ev({ id: "review:c1:manual", kind: "review_needed", group: "needs_you", title: "A card", seenAt: NOW - 1000 }),
        ]),
      },
    });
    expect(await screen.findByText("1 thing needs you.")).toBeTruthy();
    const plugin = screen.getByText("A refused plugin").closest(".ux-row")!;
    expect(plugin.className).toContain("ux-row--muted");
    expect(screen.getByText("A card").closest(".ux-row")!.className).not.toContain("ux-row--muted");
  });
});

function sectionHead(title: string): string {
  return screen.getByRole("heading", { level: 2, name: title }).parentElement!.textContent ?? "";
}

// N19: a row's detail wraps to two lines and is clamped there; its full text
// is the line's tooltip and describes the row's buttons — a long sentence is
// never cut to one line with no way to read it.
describe("Inbox row details (N19)", () => {
  const LONG =
    "Their cards were archived without shipping, so the work is only on these branches, not on the main branch: plyloft/card-a1-a-rather-long-branch-name and plyloft/card-a2-another-long-one";

  it("clamps the detail at two lines, never one", () => {
    const css = readFileSync("src/components/ux/ux.css", "utf8");
    const rule = /\.ux-inbox-detail \{([^}]*)\}/.exec(css)![1];
    expect(rule).toContain("-webkit-line-clamp: 2");
    expect(rule).toContain("overflow-wrap: anywhere");
    expect(rule).not.toContain("white-space: nowrap");
    expect(rule).not.toContain("text-overflow: ellipsis");
  });

  it("gives every kind of row's detail its full text as a tooltip and as its buttons' description", async () => {
    seedWorkspace();
    renderUi(<InboxPanel />, {
      fixtures: {
        inbox_feed: feedOf([
          ev({ id: "r1", kind: "review_needed", group: "needs_you", title: "With a long line", detail: LONG }),
          ev({ id: "r2", kind: "run_failed", group: "needs_you", title: "Failed one", cardId: "c2", detail: "Short." }),
          ev({ id: "r3", kind: "review_needed", group: "needs_you", title: "No detail", cardId: "c3" }),
        ]),
      },
    });
    const line = await screen.findByText(LONG);
    expect(line.className).toBe("ux-inbox-detail");
    expect(line.getAttribute("title")).toBe(LONG);
    const row = line.closest(".ux-row")! as HTMLElement;
    for (const button of within(row).getAllByRole("button")) {
      expect(button.getAttribute("aria-describedby")).toBe(line.id);
    }
    expect(within(row).getAllByRole("button")[0]).toHaveProperty("textContent", "See the review");
    const short = screen.getByText("Short.");
    expect(short.getAttribute("title")).toBe("Short.");
    // A row whose own detail is empty still says its kind's line, described.
    const other = screen.getByText("No detail").closest(".ux-row")! as HTMLElement;
    const otherLine = other.querySelector<HTMLElement>(".ux-inbox-detail")!;
    expect(otherLine.getAttribute("title")).toBe(otherLine.textContent);
    expect(within(other).getAllByRole("button")[0].getAttribute("aria-describedby")).toBe(otherLine.id);
  });
});

// QoL 14.2 (F7): a pull request someone asked this member to review.
describe("a review-requested pull request's row", () => {
  const prEv = ev({
    id: "pr:o/lyra#7",
    kind: "pr_review",
    group: "needs_you",
    cardId: null,
    title: "Fix the login",
    detail: "PR #7 · ana",
    url: "https://github.com/o/lyra/pull/7",
    at: NOW - 3 * 3_600_000,
  });

  it("offers the review in Plyloft, Open on GitHub and Copy link, and says its age", async () => {
    seedWorkspace();
    const { user, tauri: t } = renderUi(<InboxPanel />, {
      fixtures: { inbox_feed: feedOf([prEv]), open_web_link: null, inbox_mark_seen: null },
    });
    const row = (await screen.findByText("Fix the login")).closest(".ux-row")! as HTMLElement;
    // A5 (A0): the one action, then the row's other answers in its ⋯.
    expect(within(row).getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual([
      "Have it reviewed",
      "More for Fix the login",
    ]);
    expect(row.querySelector(".ux-inbox-when")?.textContent).toBe("opened 3h ago");
    t.allowUnhandled();
    await user.click(within(row).getByRole("button", { name: "More for Fix the login" }));
    const menu = screen.getByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["Open on GitHub", "Copy link"]);
    await user.click(within(menu).getByRole("menuitem", { name: "Open on GitHub" }));
    await waitFor(() => expect(t.callsOf("open_web_link")[0]?.args).toEqual({ url: "https://github.com/o/lyra/pull/7" }));
    // The review: the Board's Review a pull request sheet, with #7 picked.
    await user.click(within(row).getByRole("button", { name: "Have it reviewed" }));
    expect(useBoard.getState().prReviewAsk).toEqual({ workspaceId: "l", number: 7, at: expect.any(Number) });
    expect(useUi.getState().centerMode.l).toBe("board");
  });

  it("opens the review card when the Board has one", async () => {
    seedWorkspace();
    act(() =>
      useKanban.setState({
        byWorkspace: {
          l: {
            loaded: true,
            cards: [{ id: "card-pr7", workspaceId: "l", title: "Review: Fix the login", archived: false, prReview: { repo: "O/Lyra", number: 7 } } as never],
          },
        } as never,
      }),
    );
    const { user, tauri: t } = renderUi(<InboxPanel />, { fixtures: { inbox_feed: feedOf([prEv]), inbox_mark_seen: null } });
    const button = await screen.findByRole("button", { name: "Open the review card" });
    t.allowUnhandled();
    await user.click(button);
    expect(useUi.getState().selectedCardId.l).toBe("card-pr7");
    expect(useBoard.getState().prReviewAsk).toBeNull();
  });
});

// 1.169.0 (C3): the sessions open when Plyloft quit are offered in
// Terminals; the Inbox points there.
describe("the Inbox's pointer to the sessions open at quit", () => {
  it("says how many, opens Terminals, and goes with the offer", async () => {
    const { useReopen } = await import("../store/reopenStore");
    const { useDoctor } = await import("../store/doctorStore");
    seedWorkspace();
    act(() => {
      useDoctor.setState({ env: { path: "/usr/bin", shell: "/bin/zsh", claudePath: "/usr/local/bin/claude", claudeVersion: "2.1.232", codexPath: "/usr/local/bin/codex", codexVersion: "0.163.0", codexHealthy: true, gitPath: "/usr/bin/git", gitVersion: "2.50.1", ghPath: null, ghVersion: null, supportsStreamJson: true, probeError: null } } as never);
      useReopen.setState({
        byWorkspace: {
          l: [
            { id: "r1", kind: "claude", cwd: lyra.cwd, cliSessionId: "c-1", startedAt: 1, endedAt: 9, title: "Dark mode", titleSource: "cli", openAtQuit: 9, live: false },
            { id: "r2", kind: "codex", cwd: lyra.cwd, cliSessionId: "x-1", startedAt: 2, endedAt: 9, title: "Cache tests", titleSource: "user", openAtQuit: 9, live: false },
          ],
        },
      });
    });
    const r = renderUi(<InboxPanel />, { fixtures: { inbox_feed: feedOf([]) } });
    const pointer = await screen.findByRole("button", { name: /2 sessions were open when Plyloft quit · Reopen them in Terminals/ });
    expect(pointer.getAttribute("title")).toBe("Claude: Dark mode\nCodex: Cache tests");
    await r.user.click(pointer);
    expect(useUi.getState().centerMode.l).toBe("terminals");
    // F3 (1.172.1): a session opened in that workspace puts the offer away,
    // and the pointer with it.
    const { useTiles } = await import("../store/tileStore");
    r.tauri.allowUnhandled();
    act(() => useReopen.setState({ since: Date.now() }));
    act(() => void useTiles.getState().addShellTile("l", lyra.cwd));
    expect(useReopen.getState().byWorkspace).toEqual({});
    expect(screen.queryByRole("button", { name: /were open when Plyloft quit/ })).toBeNull();
  });
});

// 1.169.1 (R1, walk R3 step A4): a pull request ready to merge asks for you
// — its row's Merge is the card's own Merge (`card_pr_merge`), with the same
// refusals, said in a toast.
describe("a green pull request's row", () => {
  const URL = "https://github.com/o/lyra/pull/108";
  const prCard = (pr: Record<string, unknown> = {}) => ({
    id: "c1",
    workspaceId: "l",
    title: "Add sum",
    columnId: "in_progress",
    lastRunStatus: "success",
    verifyStatus: "passed",
    reviewStatus: "merged",
    shipStatus: "unshipped",
    worktreePath: "/tmp/c1",
    createdAt: 1,
    updatedAt: 1,
    prUrl: URL,
    pr: {
      number: 108,
      state: "open",
      checks: "passing",
      checksTotal: 1,
      checksPassed: 1,
      checksPending: 0,
      failingChecks: [],
      mergeable: "mergeable",
      reviewDecision: "none",
      headSha: "h1",
      checkedAt: NOW - 60_000,
      ...pr,
    },
  });
  const seed = (card: ReturnType<typeof prCard>) =>
    act(() => useKanban.setState({ byWorkspace: { l: { loaded: true, cards: [card] } } } as never));

  it("offers Merge, which is the card's Merge", async () => {
    seedWorkspace();
    const card = prCard();
    seed(card);
    const { user, tauri: t } = renderUi(<InboxPanel />, {
      fixtures: {
        inbox_feed: feedOf([ev({ id: "pr-ready:c1:108:h1", kind: "pr_ready_to_merge", group: "needs_you", title: "Add sum", url: URL })]),
        card_pr_merge: { card: { ...card, pr: { ...card.pr, state: "merged" } }, merged: true, refused: null, github: null },
      },
    });
    const row = (await screen.findByText("Ready to merge · checks passed on GitHub")).closest(".ux-row")! as HTMLElement;
    const merge = within(row).getByRole("button", { name: "Merge" });
    // A5 (P16): bordered, as on the Board; the card is in ⋯ (round 1).
    expect(merge.className).not.toContain("cbtn--accent");
    expect(within(row).getByRole("button", { name: "More for Add sum" })).toBeTruthy();
    t.allowUnhandled();
    await user.click(merge);
    await waitFor(() => expect(t.callsOf("card_pr_merge")[0]?.args).toEqual({ workspaceId: "l", cardId: "c1" }));
    expect(t.callsOf("card_pr_merge")).toHaveLength(1);
  });

  // A5 (inbox.html scene 2): Merge merges here and says "Merging…", off,
  // until GitHub answers; the other rows stay usable.
  it("says Merging… while the merge is on its way", async () => {
    seedWorkspace();
    const card = prCard();
    seed(card);
    let answer: (v: unknown) => void = () => {};
    const { user, tauri: t } = renderUi(<InboxPanel />, {
      fixtures: {
        inbox_feed: feedOf([ev({ id: "pr-ready:c1:108:h1", kind: "pr_ready_to_merge", group: "needs_you", title: "Add sum", url: URL })]),
        card_pr_merge: () => new Promise((resolve) => (answer = resolve)),
      },
    });
    const row = (await screen.findByText("Ready to merge · checks passed on GitHub")).closest(".ux-row")! as HTMLElement;
    t.allowUnhandled();
    await user.click(within(row).getByRole("button", { name: "Merge" }));
    const busy = await within(row).findByRole("button", { name: "Merging…" });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    await act(async () => answer({ card: { ...card, pr: { ...card.pr, state: "merged" } }, merged: true, refused: null, github: null }));
    await waitFor(() => expect(within(row).queryByRole("button", { name: "Merging…" })).toBeNull());
  });

  it("opens the card instead when its Now doesn't offer Merge", async () => {
    seedWorkspace();
    // The Challenger's request for changes covers the latest snapshot: the
    // card's Merge refuses, so the row has none.
    seed({ ...prCard(), builder: { snapshots: [{ n: 1, sha: "h1", at: 1 }], review: { snapshotN: 1, status: "done", verdict: "changes_requested", at: 2 } } } as never);
    renderUi(<InboxPanel />, {
      fixtures: {
        inbox_feed: feedOf([ev({ id: "pr-ready:c1:108:h1", kind: "pr_ready_to_merge", group: "needs_you", title: "Add sum", url: URL })]),
      },
    });
    const row = (await screen.findByText("Add sum")).closest(".ux-row")! as HTMLElement;
    expect(within(row).queryByRole("button", { name: "Merge" })).toBeNull();
  });

  const readyRow = () =>
    feedOf([ev({ id: "pr-ready:c1:108:h1", kind: "pr_ready_to_merge", group: "needs_you", title: "Add sum", url: URL })]);

  it("says a refused Merge in a toast, with GitHub's answer under Details", async () => {
    seedWorkspace();
    const card = prCard();
    seed(card);
    const { user, tauri: t } = renderUi(<InboxPanel />, {
      fixtures: {
        inbox_feed: readyRow(),
        card_pr_merge: {
          card,
          merged: false,
          refused: "Not merged: GitHub refused. Its answer is below.",
          github: "GraphQL: Pull request is not mergeable",
        },
      },
    });
    t.allowUnhandled();
    await user.click(await screen.findByRole("button", { name: "Merge" }));
    await waitFor(() => expect(latestToast()?.title).toBe("Not merged: GitHub refused. Its answer is below."));
    expect(latestToast()?.kind).toBe("error");
    expect(latestToast()?.details).toBe("GraphQL: Pull request is not mergeable");
  });

  it("says a Merge that couldn't reach GitHub in a toast", async () => {
    seedWorkspace();
    seed(prCard());
    const { user, tauri: t } = renderUi(<InboxPanel />, {
      fixtures: {
        inbox_feed: readyRow(),
        card_pr_merge: () => {
          throw new Error("gh: network unreachable");
        },
      },
    });
    t.allowUnhandled();
    await user.click(await screen.findByRole("button", { name: "Merge" }));
    await waitFor(() =>
      expect(latestToast()?.title).toBe("The pull request wasn't merged"),
    );
    // 1.176.2 (E1): the cause in words, and what was left as it was.
    expect(latestToast()?.body).toBe("Something went wrong; Details has the tool's own words. Nothing was merged. Try again.");
    expect(latestToast()?.details).toContain("gh: network unreachable");
    // The row's Merge is pressable again.
    await waitFor(() => expect((screen.getByRole("button", { name: "Merge" }) as HTMLButtonElement).disabled).toBe(false));
  });
});

// G5: a card merged on GitHub whose project folder stayed behind asks to
// bring this computer up to date — the card's own press, said in a toast.
describe("a merged card's Bring this Mac up to date row", () => {
  const URL = "https://github.com/o/lyra/pull/108";
  const merged = {
    id: "c1",
    workspaceId: "l",
    title: "Add sum",
    columnId: "complete",
    lastRunStatus: "success",
    verifyStatus: "passed",
    reviewStatus: "merged",
    shipStatus: "shipped",
    createdAt: 1,
    updatedAt: 1,
    prUrl: URL,
    pr: {
      number: 108,
      state: "merged",
      checks: "passing",
      checksTotal: 1,
      checksPassed: 1,
      checksPending: 0,
      failingChecks: [],
      mergeable: "unknown",
      reviewDecision: "none",
      headSha: "h1",
      checkedAt: NOW - 60_000,
      upToDateRefused: "You have changes that aren't in a commit",
    },
  };
  const row = () =>
    feedOf([
      ev({
        id: "up-to-date:c1:108:h1",
        kind: "bring_up_to_date",
        group: "needs_you",
        title: "Add sum",
        detail: "You have changes that aren't in a commit",
        url: URL,
      }),
    ]);

  it("runs the card's press and says what it got", async () => {
    seedWorkspace();
    act(() => useKanban.setState({ byWorkspace: { l: { loaded: true, cards: [merged] } } } as never));
    const { user, tauri: t } = renderUi(<InboxPanel />, {
      fixtures: {
        inbox_feed: row(),
        card_bring_up_to_date: { card: merged, refused: "This folder is on dev, not main" },
      },
    });
    const line = await screen.findByText("You have changes that aren't in a commit");
    const press = within(line.closest(".ux-row")! as HTMLElement).getByRole("button", {
      name: "Bring this Mac up to date",
    });
    t.allowUnhandled();
    await user.click(press);
    await waitFor(() => expect(t.callsOf("card_bring_up_to_date")[0]?.args).toEqual({ workspaceId: "l", cardId: "c1" }));
    await waitFor(() =>
      expect(latestToast()?.title).toBe(
        "Merged. This folder is on dev, not main, so this Mac wasn't brought up to date.",
      ),
    );
  });

  // A5 round 1 (scene 5): it takes Merge's place, above the other rows.
  it("comes before a row that only opens its card", async () => {
    seedWorkspace();
    act(() => useKanban.setState({ byWorkspace: { l: { loaded: true, cards: [merged] } } } as never));
    const feed = row();
    renderUi(<InboxPanel />, {
      fixtures: {
        inbox_feed: {
          ...feed,
          events: [ev({ id: "r9", kind: "review_needed", group: "needs_you", title: "Another card", cardId: "elsewhere" }), ...feed.events],
        },
      },
    });
    await screen.findByText("You have changes that aren't in a commit");
    const needs = screen.getByRole("group", { name: "Needs you" });
    expect(within(needs).getAllByRole("button")[0].textContent).toBe("Bring this Mac up to date");
  });
});

// A5 round 1 (inbox.html scene 4): with only a round of ideas, the page says
// Nothing needs you with its one way out, no sentence, then the News; the
// unseen row has the accent dot, gray once seen.
describe("an Inbox with only ideas", () => {
  const ideas = (seenAt: number | null) =>
    ev({
      id: "next-improvement:l:site:r1",
      kind: "next_improvement_ideas",
      group: "news",
      cardId: null,
      title: "Next improvement: 1 idea",
      detail: "Claude proposed",
      seenAt,
    });

  it("is the empty page, then the News", async () => {
    seedWorkspace();
    renderUi(<InboxPanel />, { fixtures: { inbox_feed: feedOf([ideas(null)]) } });
    expect(await screen.findByText("Nothing needs you")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Go to the Board" })).toBeTruthy();
    expect(screen.queryByText("Nothing needs you.")).toBeNull();
    const news = screen.getByRole("group", { name: "News" });
    expect(within(news).getByText("New · Claude proposed")).toBeTruthy();
    const empty = document.querySelector("[data-ply-inbox-empty]")!;
    expect(empty.compareDocumentPosition(news) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const dot = news.querySelector(".ux-state-dot")!;
    expect(dot.className).toContain("ux-state-dot--accent");
    const css = readFileSync("src/components/ux/ux.css", "utf8");
    expect(/\.ux-state-dot--accent \{([^}]*)\}/.exec(css)![1]).toMatch(/var\(--[\w-]+\)/);
  });

  it("grays the dot once seen", async () => {
    seedWorkspace();
    renderUi(<InboxPanel />, { fixtures: { inbox_feed: feedOf([ideas(NOW)]) } });
    const news = await screen.findByRole("group", { name: "News" });
    expect(news.querySelector(".ux-state-dot")!.className).toBe("ux-state-dot");
    expect(within(news).getByText("Seen · waiting for your answer")).toBeTruthy();
  });
});
