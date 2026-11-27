// UX-5.5: the Board's header — Ship N only when something can ship (it opens
// the one Release sheet on this workspace, 1.174.0), the primary New card, and a ⋯
// with Discuss and the GitHub sync (G4: Brainstorm left with the swarm UI).
import { describe, expect, it } from "vitest";
import { KanbanBoard } from "../components/KanbanBoard";
import { ReleaseSheet } from "../components/ReleaseSheet";
import { relScope, releaseFixtures } from "./releaseFixtures";
import { useBoard } from "../store/boardStore";
import { useKanban } from "../store/kanbanStore";
import { useUi } from "../store/uiStore";
import { useWorkspaces } from "../store/workspaceStore";
import { useLicense } from "../store/licenseStore";
import { TEAM_BOARD_READ_ONLY_MESSAGE } from "../lib/teamGateCardWrites";
import { requestBoardPrReview } from "../lib/boardCommands";
import { act, renderUi, screen, tauri, waitFor, within } from "./render";
import { boardCard, seedBoard, BOARD_WS } from "./boardFixtures";
import { FREE_GATES, setPlanGates, setTeamAllowed } from "./planGates";
import { FAILED_BACKOFF_MS, REFRESH_EVERY_MS } from "../lib/boardFreshness";
import { PR_REVIEW_ASK_MS } from "../store/boardStore";

const verified = (id: string) =>
  boardCard(id, {
    title: `Card ${id}`,
    columnId: "complete",
    lastRunStatus: "success",
    verifyStatus: "passed",
    shipStatus: "unshipped",
  });

describe("the Board's header", () => {
  // 1.171.0 E3 (owner D5): two or more cards, on every plan.
  it("offers Release N cards only for two or more cards, and on Free too", () => {
    act(() => seedBoard([verified("a"), boardCard("draft")]));
    const one = renderUi(<KanbanBoard workspaceId={BOARD_WS} />);
    expect(screen.queryByRole("button", { name: /^Release \d/ })).toBeNull();
    one.unmount();
    act(() => {
      seedBoard([verified("a"), verified("b")]);
      setPlanGates(FREE_GATES);
    });
    renderUi(<KanbanBoard workspaceId={BOARD_WS} />);
    const ship = screen.getByRole("button", { name: "Release 2 cards…" });
    expect(ship.textContent).not.toMatch(/\bPro\b/);
    act(() => setPlanGates(null));
  });

  it("offers Ship N only when N ≥ 2, and opens the Release sheet on this workspace's ready cards", async () => {
    act(() => seedBoard([verified("a"), verified("b"), boardCard("draft")]));
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />);
    const ship = screen.getByRole("button", { name: "Release 2 cards…" });
    expect(ship.title).toBe("Release 2 cards together, as one version");
    await r.user.click(ship);
    expect(useUi.getState().releaseSheet).toEqual({ workspaceId: BOARD_WS, cardIds: ["a", "b"] });
  });

  // GH #242: a card whose pull request merged has landed — never counted.
  it("does not count a card that landed as a merged pull request", () => {
    act(() =>
      seedBoard([
        verified("a"),
        verified("b"),
        { ...verified("m"), reviewStatus: "merged", prUrl: "https://github.com/o/r/pull/9" },
      ]),
    );
    renderUi(<KanbanBoard workspaceId={BOARD_WS} />);
    expect(screen.getByRole("button", { name: "Release 2 cards…" })).toBeTruthy();
  });

  // GH #252: on a read-only Board New card and Ship say why they are off,
  // where they sit, and pressing them raises nothing.
  it("disables New card and Ship on a read-only Board, with the reason as the title", async () => {
    act(() => {
      seedBoard([verified("a"), verified("b")]);
      useWorkspaces.setState((s) => ({
        workspaces: s.workspaces.map((w) =>
          w.id === BOARD_WS ? { ...w, kanbanSyncMode: "githubIssues" as const } : w,
        ),
      }));
      useLicense.setState({ info: null });
    });
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />, { withToasts: true });
    const newCard = screen.getByRole("button", { name: "New card" }) as HTMLButtonElement;
    const ship = screen.getByRole("button", { name: "Release 2 cards…" }) as HTMLButtonElement;
    for (const button of [newCard, ship]) {
      expect(button.disabled).toBe(true);
      // 1.176.2 (E1): the reason is the button's `reason`, drawn by its marker.
      expect(button.parentElement?.querySelector(".cbtn-reason")?.getAttribute("data-reason")).toBe(TEAM_BOARD_READ_ONLY_MESSAGE);
      await r.user.click(button);
    }
    expect(useUi.getState().releaseSheet).toBeNull();
    expect(screen.queryByText("Board is read-only")).toBeNull();
  });

  // SP-D: an approved Builder card in In progress says Ready to ship, as its
  // page does; the header's Ship N counts only what the batch takes —
  // 1.171.0 F1: with its session closed, the batch takes it.
  it("shows an approved Builder card in In progress as Ready to ship, counted in Ship N once its session is closed", () => {
    const approved = boardCard("built", {
      title: "Built",
      columnId: "in_progress",
      lastRunStatus: "success",
      verifyStatus: "passed",
      shipStatus: "unshipped",
      worktreePath: "/tmp/ply-test/built",
      builder: {
        vendor: "claude",
        bypass: false,
        ptyId: null,
        sessionLost: false,
        startedAt: 1,
        snapshots: [{ n: 1, sha: "a", at: 2 }],
        review: { snapshotN: 1, provider: "codex", degraded: false, status: "done", verdict: "approve", at: 3 },
      },
    });
    act(() => seedBoard([approved, verified("a")]));
    renderUi(<KanbanBoard workspaceId={BOARD_WS} />);
    for (const id of ["built", "a"]) {
      const el = document.querySelector(`[data-ply-board-card-id="${id}"]`) as HTMLElement;
      expect(within(el).getByText("Ready to ship")).toBeTruthy();
    }
    expect(screen.getByRole("button", { name: "Release 2 cards…" }).title).toBe("Release 2 cards together, as one version");
  });

  // SP-D: with its Builder session open the card can still commit, so the
  // Board reads its live tip as the page does (`card_review_tip`).
  describe("an approved Builder card with its session open", () => {
    const liveCard = (id: string) =>
      boardCard(id, {
        title: `Live ${id}`,
        columnId: "in_progress",
        lastRunStatus: "success",
        verifyStatus: "passed",
        shipStatus: "unshipped",
        worktreePath: `/tmp/ply-test/${id}`,
        builder: {
          vendor: "claude",
          bypass: false,
          ptyId: `pty-${id}`,
          sessionLost: false,
          startedAt: 1,
          snapshots: [{ n: 1, sha: "aaa", at: 2 }],
          review: { snapshotN: 1, provider: "codex", degraded: false, status: "done", verdict: "approve", at: 3 },
        },
      });
    const chipOf = (id: string) =>
      document.querySelector(`[data-ply-board-card-id="${id}"]`) as HTMLElement;

    it("says Ready to ship when the tip is the reviewed snapshot", async () => {
      act(() => seedBoard([liveCard("tip-same")]));
      tauri().fixture("card_review_tip", { branchTip: "aaa", commitsSinceReview: 0 });
      renderUi(<KanbanBoard workspaceId={BOARD_WS} />);
      await waitFor(() => expect(within(chipOf("tip-same")).getByText("Ready to ship")).toBeTruthy());
      expect(tauri().callsOf("card_review_tip").length).toBeGreaterThan(0);
    });

    it("says the commits since the review when the tip moved", async () => {
      act(() => seedBoard([liveCard("tip-moved")]));
      tauri().fixture("card_review_tip", { branchTip: "bbb", commitsSinceReview: 2 });
      renderUi(<KanbanBoard workspaceId={BOARD_WS} />);
      await waitFor(() =>
        expect(within(chipOf("tip-moved")).getByText("2 commits since the last review")).toBeTruthy(),
      );
      expect(within(chipOf("tip-moved")).queryByText("Ready to ship")).toBeNull();
    });

    it("says Result ready while the tip is loading", async () => {
      act(() => seedBoard([liveCard("tip-loading")]));
      tauri().fixture("card_review_tip", () => new Promise(() => {}));
      renderUi(<KanbanBoard workspaceId={BOARD_WS} />);
      await waitFor(() => expect(tauri().callsOf("card_review_tip").length).toBeGreaterThan(0));
      expect(within(chipOf("tip-loading")).getByText("Result ready")).toBeTruthy();
    });

    it("reads the same tip in the List", async () => {
      act(() => {
        seedBoard([liveCard("tip-list"), liveCard("tip-list-moved")]);
        useBoard.getState().setView(BOARD_WS, "list");
      });
      tauri().fixture("card_review_tip", (args: Record<string, unknown>) =>
        args.cardId === "tip-list"
          ? { branchTip: "aaa", commitsSinceReview: 0 }
          : { branchTip: "bbb", commitsSinceReview: 1 },
      );
      renderUi(<KanbanBoard workspaceId={BOARD_WS} />);
      const table = screen.getByRole("table", { name: "Cards" });
      const rowOf = (title: string) => within(table).getByText(title).closest("tr") as HTMLElement;
      await waitFor(() => expect(within(rowOf("Live tip-list")).getByText("Ready to ship")).toBeTruthy());
      await waitFor(() =>
        expect(within(rowOf("Live tip-list-moved")).getByText("1 commit since the last review")).toBeTruthy(),
      );
    });

    it("reads no tip for an open session that is not ready to ship", () => {
      const failing = liveCard("tip-failing");
      act(() => seedBoard([{ ...failing, verifyStatus: "failed" }]));
      renderUi(<KanbanBoard workspaceId={BOARD_WS} />);
      expect(tauri().callsOf("card_review_tip")).toHaveLength(0);
    });

    it("reads no tip for a card with no open session", () => {
      const closed = liveCard("tip-closed");
      act(() => seedBoard([{ ...closed, builder: { ...closed.builder!, ptyId: null } }]));
      renderUi(<KanbanBoard workspaceId={BOARD_WS} />);
      expect(within(chipOf("tip-closed")).getByText("Ready to ship")).toBeTruthy();
      expect(tauri().callsOf("card_review_tip")).toHaveLength(0);
    });
  });

  // 1.171.0 E3 (BI-3): a Needs you card says its one press — the card's
  // own primary — and pressing the card opens it, running nothing.
  it("a Needs you card says → its primary, and the press opens the card", async () => {
    act(() => seedBoard([verified("a"), boardCard("draft", { title: "Draft" })]));
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />);
    r.tauri.allowUnhandled();
    const tile = (id: string) => document.querySelector(`[data-board-card-id="${id}"]`) as HTMLElement;
    const next = tile("a").querySelector("[data-ply-board-card-next]") as HTMLElement;
    expect(tile("a").closest("[data-board-column]")?.getAttribute("data-board-column")).toBe("needs-you");
    expect(next.textContent).toBe("→ Next: See the review");
    expect(next.querySelector(".sr-only")?.textContent).toBe("Next: ");
    expect(tile("draft").querySelector("[data-ply-board-card-next]")).toBeNull();
    const before = r.tauri.calls.length;
    await r.user.click(within(tile("a")).getByRole("button", { name: /Card a/ }));
    expect(useUi.getState().selectedCardId[BOARD_WS]).toBe("a");
    expect(useUi.getState().releaseSheet).toBeNull();
    expect(r.tauri.calls.slice(before).map((c) => c.cmd).filter((c) => /ship|start|finish/.test(c))).toEqual([]);
  });

  // 1.171.0 E3 (walk #5g): an empty column is narrow, one with cards isn't.
  it("marks the empty columns narrow", () => {
    act(() => seedBoard([verified("a")]));
    renderUi(<KanbanBoard workspaceId={BOARD_WS} />);
    const col = (id: string) => document.querySelector(`[data-board-column="${id}"]`) as HTMLElement;
    expect(col("needs-you").classList.contains("board-column--empty")).toBe(false);
    expect(col("done").classList.contains("board-column--empty")).toBe(true);
  });

  it("has no Ship button with nothing to ship, keeps Discuss in the ⋯, and offers no Brainstorm", async () => {
    act(() => seedBoard([boardCard("draft")]));
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />);
    expect(screen.queryByRole("button", { name: /^Ship/ })).toBeNull();
    expect(screen.getByRole("button", { name: "New card" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Brainstorm/ })).toBeNull();
    await r.user.click(screen.getByRole("button", { name: "More for the Board" }));
    expect(screen.queryByRole("menuitem", { name: /Brainstorm/ })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Discuss…" })).toBeTruthy();
  });

  // QoL 1.168 (block 10, C16): Review a pull request is in the ⋯, so the
  // header is one row at 1280 with the sidebar open.
  it("opens Review a pull request from ⌘K's request too", async () => {
    act(() => seedBoard([boardCard("draft")]));
    renderUi(<KanbanBoard workspaceId={BOARD_WS} />, {
      fixtures: { pr_review_list: () => ({ repo: "o/r", prs: [] }) },
    });
    act(() => requestBoardPrReview(BOARD_WS));
    expect(await screen.findByRole("dialog", { name: /Review a pull request/ })).toBeTruthy();
  });

  it("offers Review a pull request in the ⋯, not as a header button", async () => {
    act(() => seedBoard([boardCard("draft")]));
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />, {
      fixtures: { pr_review_list: () => ({ repo: "o/r", prs: [] }) },
    });
    expect(screen.queryByRole("button", { name: /Review a pull request/ })).toBeNull();
    await r.user.click(screen.getByRole("button", { name: "More for the Board" }));
    await r.user.click(screen.getByRole("menuitem", { name: /Review a pull request/ }));
    expect(await screen.findByRole("dialog", { name: /Review a pull request/ })).toBeTruthy();
  });

  it("the Release sheet opened from a Board ticks what that Board asked for", async () => {
    act(() => {
      useKanban.setState({
        byWorkspace: { [BOARD_WS]: { cards: [verified("a"), verified("b")], loaded: true } },
      });
    });
    renderUi(<ReleaseSheet ask={{ workspaceId: BOARD_WS, areaId: null, cardIds: ["b"] }} onClose={() => {}} />, {
      fixtures: releaseFixtures(relScope({ workspaceId: BOARD_WS, readyCardIds: ["a", "b"] })),
    });
    await waitFor(() =>
      expect((screen.getByRole("checkbox", { name: /Card b/ }) as HTMLInputElement).checked).toBe(true),
    );
    expect((screen.getByRole("checkbox", { name: /Card a/ }) as HTMLInputElement).checked).toBe(false);
  });

  // 1.174.0 (DR3, state 1): ⋯ › Release… says what the release would carry,
  // read when the ⋯ opens — on with only what is on main, off with the
  // true reason, on every plan.
  it("⋯ › Release… says what is new on main since the last tag, and opens the sheet", async () => {
    act(() => {
      seedBoard([boardCard("draft")]);
      setPlanGates(FREE_GATES);
    });
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />, {
      fixtures: { release_scopes: [relScope({ workspaceId: BOARD_WS })] },
    });
    await r.user.click(screen.getByRole("button", { name: "More for the Board" }));
    expect(r.tauri.callsOf("release_scopes")).toHaveLength(1);
    const item = await screen.findByRole("menuitem", { name: /Release…/ });
    await waitFor(() => expect(item.textContent).toContain("2 cards and 1 other change on main since v3.0.1"));
    expect(item.textContent).not.toContain("Pro");
    await r.user.click(item);
    expect(useUi.getState().releaseSheet).toEqual({ workspaceId: BOARD_WS, areaId: null });
    act(() => setPlanGates(null));
  });

  // 1.174.0 (C13, BCI-14): one Release — the ⋯ has none while the header
  // has Release N cards…, on every plan; back in the ⋯ without it (one card ready).
  it("⋯ has no Release… while the header has Release 2 cards…, on Free too", async () => {
    act(() => {
      seedBoard([verified("a"), verified("b")]);
      setPlanGates(FREE_GATES);
    });
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />, {
      fixtures: { release_scopes: [relScope({ workspaceId: BOARD_WS, readyCardIds: ["a", "b"] })] },
    });
    const header = screen.getByRole("button", { name: "Release 2 cards…" });
    expect(header.className).not.toContain("cbtn--accent");
    await r.user.click(screen.getByRole("button", { name: "More for the Board" }));
    expect(screen.queryByRole("menuitem", { name: /^Release/ })).toBeNull();
    act(() => setPlanGates(null));
  });

  it("⋯ › Release… is off with nothing new since the last tag, saying since when", async () => {
    act(() => seedBoard([boardCard("draft")]));
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />, {
      fixtures: {
        release_scopes: [
          relScope({ workspaceId: BOARD_WS, cards: [], cardsTotal: 0, otherChanges: [], otherTotal: 0, sinceAt: Date.now() - 86_400_000 }),
        ],
      },
    });
    await r.user.click(screen.getByRole("button", { name: "More for the Board" }));
    const item = (await screen.findByRole("menuitem", { name: /Release…/ })) as HTMLButtonElement;
    await waitFor(() => expect(item.textContent).toContain("Nothing new on main since v3.0.1, released yesterday."));
    expect(item.getAttribute("aria-disabled") === "true" || item.disabled).toBe(true);
  });

  it("New card from the List, or under a filter, opens the field on the columns", async () => {
    act(() => {
      seedBoard([boardCard("draft", { title: "Existing" })]);
      useBoard.getState().setView(BOARD_WS, "list");
      useBoard.getState().setFilter(BOARD_WS, { query: "nothing matches this" });
    });
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />);
    await r.user.click(screen.getByRole("button", { name: "New card" }));
    const field = await screen.findByRole("textbox", { name: "New card title" });
    expect(useBoard.getState().view[BOARD_WS]).toBe("board");
    expect(useBoard.getState().filter[BOARD_WS].query).toBe("");
    expect(field.closest("[data-board-column]")?.getAttribute("data-board-column")).toBe(
      "not-started",
    );
  });

  // SP-1 walk: back from the List to the columns, an empty "New card
  // title" field opened by itself — the columns remount and the earlier
  // New card's request was still counted. A request opens the field once.
  it("does not open the New card field again when the List goes back to the columns", async () => {
    act(() => seedBoard([boardCard("draft", { title: "Existing" })]));
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />);
    await r.user.click(screen.getByRole("button", { name: "New card" }));
    const field = await screen.findByRole("textbox", { name: "New card title" });
    await r.user.type(field, "{Escape}");
    expect(screen.queryByRole("textbox", { name: "New card title" })).toBeNull();
    act(() => useBoard.getState().setView(BOARD_WS, "list"));
    act(() => useBoard.getState().setView(BOARD_WS, "board"));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    expect(screen.queryByRole("textbox", { name: "New card title" })).toBeNull();
    // A new press still opens it.
    await r.user.click(screen.getByRole("button", { name: "New card" }));
    expect(await screen.findByRole("textbox", { name: "New card title" })).toBeTruthy();
  });

  // GH #300: no provenance chip (1.172.1 F2: a licensed GitHub-backed Board's
  // source line under the title names its issues; this one is read-only);
  // read-only is one line with its link, and "licence" is spelled one way.
  it("names no GitHub provenance, and says read-only once with the way out", async () => {
    const gh = (licensed: boolean) =>
      act(() => {
        seedBoard([boardCard("draft")]);
        useWorkspaces.setState((s) => ({
          workspaces: s.workspaces.map((w) =>
            w.id === BOARD_WS ? { ...w, kanbanSyncMode: "githubIssues" as const } : w,
          ),
        }));
        useLicense.setState({ info: licensed ? useLicense.getState().info : null });
      });
    gh(false);
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />);
    expect(screen.queryByText("GitHub Issues")).toBeNull();
    expect(document.querySelector(".cchip")).toBeNull();
    const line = document.querySelector("[data-board-read-only]");
    // Launch G3: the way out is the plan, not a licence to renew.
    expect(line?.textContent).toBe("This board is read-only.See your plan");
    expect(TEAM_BOARD_READ_ONLY_MESSAGE).not.toMatch(/licen[cs]e/);
    await r.user.click(screen.getByRole("button", { name: "See your plan" }));
    expect(useUi.getState().settingsOverlayOpen).toBe(true);
  });
});

// QoL 14.1 (C19): a GitHub-backed Board says when it last read GitHub and
// reads it again on its own, read only (never the push-and-pull Sync).
// 1.172.1 (F2): that is one line under the title — where the cards come
// from, when they were read, and Get new issues (once "Updated … · Refresh").
function seedGithubBoard(repo: string | null = "MatteoB-adv/lyra") {
  act(() => {
    seedBoard([boardCard("draft")]);
    useWorkspaces.setState((s) => ({
      activeId: BOARD_WS,
      workspaces: s.workspaces.map((w) =>
        w.id === BOARD_WS ? { ...w, kanbanSyncMode: "githubIssues" as const, githubOwnerRepo: repo } : w,
      ),
    }));
    useUi.getState().setCenterMode(BOARD_WS, "board");
    setTeamAllowed(true);
  });
}
const sourceLine = () => document.querySelector("[data-ply-board-source]");
const sourceWords = () => (sourceLine()?.textContent ?? "").replace(/\s+/g, " ");
const announced = () => document.querySelector("[data-ply-board-source-status]")?.textContent ?? "";

describe("a GitHub-backed Board's source line", () => {
  const empty = { created: 0, patched: 0, missing: [], prunedWorktrees: 0, trashFreedBytes: 0 };

  it("says the same read in its line and in its status (block C)", async () => {
    seedGithubBoard();
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />, {
      fixtures: { kanban_github_reconcile: () => empty },
    });
    r.tauri.allowUnhandled();
    await waitFor(() => expect(announced()).toBe("read just now"));
    const at = Date.now() - 2 * 60_000;
    act(() => useKanban.setState({ freshness: { [BOARD_WS]: { at, triedAt: at, failed: false } } }));
    await waitFor(() => expect(sourceWords()).toContain("read 2 min ago"));
    expect(announced()).toBe("");
  });

  it("says the cards are the repository's issues, under the title, read only", async () => {
    seedGithubBoard();
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />, {
      fixtures: {
        kanban_github_reconcile: () => empty,
        kanban_github_refresh: () => empty,
        kanban_load: () => useKanban.getState().byWorkspace[BOARD_WS]?.cards ?? [],
        open_web_link: () => undefined,
      },
    });
    r.tauri.allowUnhandled();
    // The on-open Sync is the first read.
    await waitFor(() =>
      expect(sourceWords()).toBe("Cards come from the GitHub issues of MatteoB-adv/lyra · read just now · Get new issues"),
    );
    // Under the title, in the header — not among the actions.
    expect(sourceLine()?.closest(".ux-screen-subtitle")).toBeTruthy();
    expect(sourceLine()?.closest(".ux-screen-actions")).toBeNull();
    // The old top-right words are gone.
    expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
    expect(document.body.textContent).not.toContain("Updated just now");
    expect(r.tauri.callsOf("kanban_github_reconcile")).toHaveLength(1);
    const get = screen.getByRole("button", { name: "Get new issues" });
    expect(get.title).toBe(
      "Read this board's GitHub issues again: a new issue becomes a card, and an edited or closed issue updates its card. Nothing is written to GitHub; Sync with GitHub in ⋯ also sends this computer's changes.",
    );
    await r.user.click(get);
    await waitFor(() => expect(r.tauri.callsOf("kanban_github_refresh")).toHaveLength(1));
    // The repository's name opens its issues on GitHub.
    await r.user.click(screen.getByRole("button", { name: "MatteoB-adv/lyra, open its issues on GitHub" }));
    expect(r.tauri.callsOf("open_web_link")[0].args).toEqual({ url: "https://github.com/MatteoB-adv/lyra/issues" });
    // The timer: due after the interval (the clock moved, the tick fires).
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + REFRESH_EVERY_MS + 1_000;
      act(() => window.dispatchEvent(new Event("focus")));
      await waitFor(() => expect(r.tauri.callsOf("kanban_github_refresh")).toHaveLength(2));
    } finally {
      Date.now = realNow;
    }
    // Never a second push-and-pull.
    expect(r.tauri.callsOf("kanban_github_reconcile")).toHaveLength(1);
  });

  // Challenger 2: the on-open Sync also writes, so it is not "reading…".
  it("says syncing with GitHub… during a Sync and reading… during Get new issues; the press waits", async () => {
    seedGithubBoard();
    let finishSync: (v: typeof empty) => void = () => {};
    let finishRead: (v: typeof empty) => void = () => {};
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />, {
      fixtures: {
        kanban_github_reconcile: () => new Promise<typeof empty>((done) => (finishSync = done)),
        kanban_github_refresh: () => new Promise<typeof empty>((done) => (finishRead = done)),
      },
    });
    r.tauri.allowUnhandled();
    const get = () => screen.getByRole("button", { name: "Get new issues" }) as HTMLButtonElement;
    await waitFor(() => expect(sourceWords()).toContain("· syncing with GitHub… ·"));
    expect(announced()).toBe("syncing with GitHub…");
    expect(get().disabled).toBe(true);
    act(() => finishSync(empty));
    await waitFor(() => expect(sourceWords()).toContain("· read just now ·"));
    expect(announced()).toBe("read just now");
    await r.user.click(get());
    await waitFor(() => expect(sourceWords()).toContain("· reading… ·"));
    expect(announced()).toBe("reading…");
    expect(get().disabled).toBe(true);
    act(() => finishRead(empty));
    await waitFor(() => expect(sourceWords()).toContain("· read just now ·"));
  });

  // Challenger 3: the minutes tick on screen only; the status says a read's
  // end once, never "read 3 min ago".
  it("does not announce the ticking minutes", async () => {
    seedGithubBoard();
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />, {
      fixtures: { kanban_github_reconcile: () => empty },
    });
    r.tauri.allowUnhandled();
    await waitFor(() => expect(announced()).toBe("read just now"));
    expect(document.querySelector(".board-source-read")?.getAttribute("aria-live")).toBeNull();
    expect(sourceLine()?.querySelector("[aria-live]")).toBeNull();
  });

  it("names no repository it doesn't know", async () => {
    seedGithubBoard(null);
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />, {
      fixtures: { kanban_github_reconcile: () => empty },
    });
    r.tauri.allowUnhandled();
    await waitFor(() =>
      expect(sourceWords()).toBe("Cards come from this project's GitHub issues · read just now · Get new issues"),
    );
  });

  it("a local Board has no source line", () => {
    act(() => seedBoard([boardCard("draft")]));
    renderUi(<KanbanBoard workspaceId={BOARD_WS} />);
    expect(sourceLine()).toBeNull();
    expect(screen.queryByRole("button", { name: "Get new issues" })).toBeNull();
  });

  it("U21: a Sync GitHub refuses for lack of access says that, on the line and in the toast", async () => {
    seedGithubBoard();
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />, {
      fixtures: {
        kanban_github_reconcile: () => {
          throw "GraphQL: Could not resolve to a Repository with the name 'MatteoB-adv/lyra'. (repository)";
        },
        kanban_github_refresh: () => empty,
      },
      withToasts: true,
    });
    r.tauri.allowUnhandled();
    await waitFor(() =>
      expect(sourceWords()).toBe("Cards come from the GitHub issues of MatteoB-adv/lyra · no access on GitHub · Get new issues"),
    );
    expect(announced()).toBe("no access on GitHub");
    expect(await screen.findByText(/GitHub doesn't give your account access to this repository\./)).toBeTruthy();
  });

  it("a failed on-open Sync says so, and the refresh still takes over after its back-off", async () => {
    seedGithubBoard();
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />, {
      fixtures: {
        kanban_github_reconcile: () => {
          throw "gh: could not resolve host";
        },
        kanban_github_refresh: () => empty,
      },
      withToasts: true,
    });
    r.tauri.allowUnhandled();
    await waitFor(() =>
      expect(sourceWords()).toBe("Cards come from the GitHub issues of MatteoB-adv/lyra · couldn't read GitHub · Get new issues"),
    );
    expect(announced()).toBe("couldn't read GitHub");
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + FAILED_BACKOFF_MS + 1_000;
      act(() => window.dispatchEvent(new Event("focus")));
      await waitFor(() => expect(r.tauri.callsOf("kanban_github_refresh")).toHaveLength(1));
      await waitFor(() => expect(sourceWords()).toContain("· read just now ·"));
    } finally {
      Date.now = realNow;
    }
  });
});

// QoL 14.2 (F7): the Inbox's Review it with the Challenger opens this Board's
// sheet with the pull request picked — only while the ask is fresh.
describe("an Inbox ask to review a pull request", () => {
  const list = {
    repo: "o/r",
    prs: [{ number: 12, title: "Add the retry", url: "u12", author: "octo", headRef: "r", baseRef: "main", crossRepository: false, draft: false, mine: false, cardId: null }],
  };
  it("opens Review a pull request with it picked, once", async () => {
    act(() => {
      seedBoard([boardCard("draft")]);
      useBoard.getState().setPrReviewAsk({ workspaceId: BOARD_WS, number: 12, at: Date.now() });
    });
    renderUi(<KanbanBoard workspaceId={BOARD_WS} />, { fixtures: { pr_review_list: () => list } });
    const radio = (await screen.findByRole("radio", { name: /#12 Add the retry/ })) as HTMLInputElement;
    expect(radio.checked).toBe(true);
    expect(useBoard.getState().prReviewAsk).toBeNull();
  });
  it("drops a leftover ask without opening anything", () => {
    act(() => {
      seedBoard([boardCard("draft")]);
      useBoard.getState().setPrReviewAsk({ workspaceId: BOARD_WS, number: 12, at: Date.now() - PR_REVIEW_ASK_MS - 1_000 });
    });
    renderUi(<KanbanBoard workspaceId={BOARD_WS} />, { fixtures: { pr_review_list: () => list } });
    expect(screen.queryByRole("heading", { name: "Review a pull request" })).toBeNull();
    expect(useBoard.getState().prReviewAsk).toBeNull();
  });
});

// 1.174.0 G3a walk (Mac, 1280): "Board · Site" and the columns' headings
// keep one line.
describe("the Board's title and headings stay on one line", () => {
  it("pins the CSS that keeps them", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync("src/components/board.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    // The title's side grows, so the buttons stay together at the right.
    expect(css).toMatch(
      /\.kanban-view \.ux-screen-title \{\s*flex: 1 0 auto;\s*min-width: 0;\s*overflow: hidden;\s*text-overflow: ellipsis;\s*white-space: nowrap;\s*\}/,
    );
    // New card and ⋯ together, never split by a wrap.
    expect(css).toMatch(/\.board-head-end \{\s*display: inline-flex;\s*align-items: center;\s*gap: var\(--space-sm\);\s*flex: none;\s*white-space: nowrap;\s*\}/);
    expect(css).toMatch(/\.kanban-view \.ux-screen-actions \{\s*flex: 0 1 auto;\s*\}/);
    expect(css).toMatch(/\.board-column-heading \{[^}]*white-space: nowrap;[^}]*\}/);
  });

  // G2 Windows walk (1280×820): the ⋯ menu, inside that no-wrap group,
  // wraps its hints in its own width — no sideways scroll, nothing past the
  // window's edge.
  it("the ⋯ menu wraps its hints whatever group it sits in", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync("src/components/ux/ux.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const menu = css.match(/\n\.ux-menu \{[^}]*\}/)![0];
    expect(menu).toMatch(/white-space: normal;/);
    expect(menu).toMatch(/overflow-x: hidden;/);
    expect(menu).toMatch(/right: 0;/);
  });

  it("puts New card and ⋯ in one group at the header's end", () => {
    act(() => seedBoard([]));
    renderUi(<KanbanBoard workspaceId={BOARD_WS} />);
    const end = document.querySelector(".board-head-end")!;
    expect(end).toBeTruthy();
    expect(within(end as HTMLElement).getByRole("button", { name: "New card" })).toBeTruthy();
    expect(within(end as HTMLElement).getByRole("button", { name: "More for the Board" })).toBeTruthy();
    expect(end.parentElement!.lastElementChild).toBe(end);
  });
});
