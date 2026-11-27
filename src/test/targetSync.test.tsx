// 1.170.0 (G6): a card behind its target, as the person meets it — the
// Board's "Behind main" / "Conflict ahead" badge, the card page's line with
// Bring in main's changes (only on the press), the toast of each outcome,
// and a bring-in's conflict in its own words. Only Tauri is a stub.
import { describe, expect, it } from "vitest";
import { KanbanBoard } from "../components/KanbanBoard";
import { CardDetailPanel } from "../components/CardDetailPanel";
import { TargetSyncLine } from "../components/TargetSyncLine";
import type { BringInResult, KanbanCard, TargetSyncReport } from "../ipc";
import { useToasts } from "../store/toastStore";
import { observeShipAttempt, useErrorBlocks } from "../store/errorBlockStore";
import { shipRefusedFor } from "../lib/shipRefusal";
import { useUi } from "../store/uiStore";
import { useWorkspaces } from "../store/workspaceStore";
import { BOARD_WS, boardCard, seedBoard } from "./boardFixtures";
import { act, renderUi, screen, waitFor, within } from "./render";

const builder = {
  vendor: "claude",
  bypass: false,
  ptyId: null,
  sessionLost: false,
  startedAt: 1,
  snapshots: [{ n: 1, sha: "abc1234", at: 1 }],
};

function built(patch: Partial<KanbanCard> = {}): KanbanCard {
  return boardCard("c1", {
    title: "Readme card",
    notes: "Do it",
    columnId: "complete",
    lastRunStatus: "success",
    verifyStatus: "passed",
    worktreePath: "/tmp/wt/c1",
    branchName: "plyloft/card-c1",
    builder,
    ...patch,
  } as Partial<KanbanCard>);
}

const reading = (patch: Partial<TargetSyncReport["cards"][string]> = {}): TargetSyncReport => ({
  target: "main",
  cards: { c1: { behind: 2, conflict: false, merging: false, ...patch } },
});

const PAGE_FIXTURES = {
  card_outcome: { filesChanged: 2, verifyConfigured: false, isRecon: false, reconVerdictNegative: false },
  improvement_proposal_state: null,
  improvement_proposal_trust_stopped: null,
  reviewer_list: [],
  verify_status: null,
  card_overlap_check: [],
  card_review_tip: null,
  ship_pending_release: { release: null, unreadable: null },
  card_review_diff: { cardId: "c1", baseBranch: "main", cardBranch: "plyloft/card-c1", files: [], generatedAt: 1 },
  verify_list_inflight: [],
  worktree_env_proposal: [],
};

function workspace() {
  useWorkspaces.setState({
    workspaces: [{ id: BOARD_WS, name: "Board", cwd: "/tmp/b", createdAt: 1, lastOpenedAt: 1, openFiles: [], activeFile: null }],
    activeId: BOARD_WS,
  });
}

function page(card: KanbanCard, fixtures: Record<string, unknown>) {
  workspace();
  act(() => seedBoard([card]));
  useUi.setState({ selectedCardId: { [BOARD_WS]: card.id }, centerMode: { [BOARD_WS]: "board" } });
  const rendered = renderUi(<CardDetailPanel workspaceId={BOARD_WS} />, {
    withToasts: true,
    fixtures: { ...PAGE_FIXTURES, kanban_load: () => [card], ...fixtures },
  });
  rendered.tauri.allowUnhandled();
  return rendered;
}

const line = () => document.querySelector("[data-ply-target-sync]") as HTMLElement | null;

/** A merge refused over an untracked file in the project folder (`atMerge`). */
function atMerge(branch: string, path: string) {
  return {
    operation: "land",
    atMerge: true,
    localBranch: {
      branch,
      outcome: {
        kind: "untrackedDiffers",
        behind: 0,
        from: "aaaaaaa",
        to: "bbbbbbb",
        paths: [path],
        items: [{ kind: "file", name: path, paths: [path], directory: false }],
        output: `error: The following untracked working tree files would be overwritten by merge:\n\t${path}\nAborting`,
        repeated: false,
      },
    },
  };
}

describe("a card behind its target (G6)", () => {
  it("the Board's card says Behind main, and Conflict ahead when bringing it in would conflict", async () => {
    workspace();
    useUi.setState({ centerMode: { [BOARD_WS]: "board" } });
    act(() => seedBoard([built()]));
    let answer = reading();
    const board = renderUi(<KanbanBoard workspaceId={BOARD_WS} />, { fixtures: { cards_target_sync: () => answer } });
    board.tauri.allowUnhandled();
    const tile = () => document.querySelector('[data-board-card-id="c1"]') as HTMLElement;
    await waitFor(() => expect(within(tile()).getByText("Behind main")).toBeTruthy());
    // 1.171.0 E3 (BI-4, DL-22): it keeps its tooltip, and is quiet —
    // 1.174.0 A7 (BCI-15): text in the facts, not a chip.
    const behindChip = within(tile()).getByText("Behind main");
    expect(behindChip.getAttribute("title")).toMatch(/^main on GitHub has .* Nothing to do unless GitHub asks for them/);
    expect(behindChip.className).toBe("board-card-fact board-card-fact--quiet");
    // Read only, and never a merge on its own.
    expect(board.tauri.callsOf("cards_target_sync")[0].args).toEqual({ workspaceId: BOARD_WS, opened: false });
    expect(board.tauri.callsOf("card_bring_in_target")).toHaveLength(0);
    board.unmount();

    answer = reading({ conflict: true });
    const again = renderUi(<KanbanBoard workspaceId={BOARD_WS} />, { fixtures: { cards_target_sync: () => answer } });
    again.tauri.allowUnhandled();
    await waitFor(() => expect(within(tile()).getByText("Conflict ahead")).toBeTruthy());
    expect(within(tile()).queryByText("Behind main")).toBeNull();
    // A conflict asks something: an outline chip with an amber dot (A7),
    // with why on hover.
    const conflictChip = within(tile()).getByText("Conflict ahead");
    expect(conflictChip.className).toBe("cchip cchip--warn");
    expect(conflictChip.getAttribute("title")).toMatch(/changed the same lines as this card/);
  });

  it("the card page reads it on open and brings main's changes in only on the press", async () => {
    const card = built();
    const merged: BringInResult = { kind: "merged", target: "main", paths: [], recorded: false, card };
    let answer = reading();
    const { tauri, user } = page(card, { cards_target_sync: () => answer, card_bring_in_target: merged });
    await waitFor(() => expect(line()).not.toBeNull());
    expect(tauri.callsOf("cards_target_sync").some((c) => c.args.opened === true)).toBe(true);
    expect(within(line()!).getByText("Behind main")).toBeTruthy();
    expect(within(line()!).getByText(/main on GitHub has 2 commits this card doesn't have\./)).toBeTruthy();
    const press = within(line()!).getByRole("button", { name: "Bring in main's changes" });
    // 1.174.0 A7: the badge is words after a dot; the press is bordered.
    expect(within(line()!).getByText("Behind main").className).toBe("ux-target-sync-lead");
    expect(press.className).toBe("cbtn");
    expect(press.getAttribute("title")).toBe(
      "Merges main from GitHub into the card's copy. Nothing is committed or pushed until you press Finish and check.",
    );
    expect(tauri.callsOf("card_bring_in_target")).toHaveLength(0);

    answer = reading({ merging: true });
    await user.click(press);
    expect(tauri.callsOf("card_bring_in_target")[0].args).toEqual({ workspaceId: BOARD_WS, cardId: "c1" });
    await waitFor(() => expect(useToasts.getState().toasts[0]?.title).toBe("main's changes are in the card's copy"));
    expect(useToasts.getState().toasts[0]?.body).toBe(
      "Nothing is committed yet. Press Finish and check to commit the merge and run the checks.",
    );
    // Brought in: the line says Finish and check commits it, with the press.
    await waitFor(() => expect(line()?.getAttribute("data-ply-target-sync")).toBe("merging"));
    expect(within(line()!).getByRole("button", { name: "Finish and check" })).toBeTruthy();
    expect(within(line()!).queryByRole("button", { name: "Bring in main's changes" })).toBeNull();
    // 1.174.0 A7 (VC-2): one filled button between Now and the line.
    const now = screen.getByRole("region", { name: "Now" });
    // (A split button's chevron is its own half, not a second primary.)
    const nowFilled = now.querySelectorAll(".cbtn--accent:not(.ux-split-toggle)").length;
    expect(nowFilled + line()!.querySelectorAll(".cbtn--accent").length).toBe(1);
    expect(within(line()!).getByRole("button", { name: "Finish and check" }).classList.contains("cbtn--accent")).toBe(
      nowFilled === 0,
    );
    // …and it can be undone from ⋯.
    await user.click(screen.getByRole("button", { name: "More for this card" }));
    expect(screen.getByRole("menuitem", { name: /Undo the merge/ })).toBeTruthy();
  });

  it("a conflict merges nothing: the toast hands it to the Builder, and the card says Conflict with main", async () => {
    const card = built();
    const met = built({
      reviewStatus: "conflict_blocked",
      shipConflict: { paths: ["README.md"], targetSha: "def5678", at: 2, branch: "main", sync: true },
    });
    const conflict: BringInResult = { kind: "conflict", target: "main", paths: ["README.md"], recorded: true, card: met };
    const { user } = page(card, {
      cards_target_sync: reading({ conflict: true }),
      card_bring_in_target: conflict,
    });
    await waitFor(() => expect(line()).not.toBeNull());
    expect(within(line()!).getByText("Conflict ahead")).toBeTruthy();
    await user.click(within(line()!).getByRole("button", { name: "Bring in main's changes" }));
    await waitFor(() => expect(useToasts.getState().toasts[0]?.title).toBe("main changed the same lines"));
    const toast = useToasts.getState().toasts[0];
    expect(toast.body).toBe("Nothing was merged, and the card's work is safe. Press Fix with the Builder.");
    expect(toast.details).toBe("README.md");
    // Walk 8.3: the toast's button has the press's own name.
    expect(toast.action?.label).toBe("Fix with the Builder");
  });

  // Immediacy walk 8.3 (Mac): Ship it (here) was refused over a file in the
  // project folder in the way of the card's merge; the file was taken away
  // by hand, then Bring in met a conflict. The old refusal led Now and hid
  // the conflict's Fix with the Builder.
  it("a Bring in takes a merge's old refusal off, so the conflict leads", async () => {
    const card = built();
    const met = built({
      reviewStatus: "conflict_blocked",
      shipConflict: { paths: ["notes.txt"], targetSha: "def5678", at: 2, branch: "main", sync: true },
    });
    const conflict: BringInResult = { kind: "conflict", target: "main", paths: ["notes.txt"], recorded: true, card: met };
    let onDisk = card;
    const { user } = page(card, {
      cards_target_sync: reading({ conflict: true }),
      card_bring_in_target: () => {
        onDisk = met;
        return conflict;
      },
      kanban_load: () => [onDisk],
    });
    act(() => {
      observeShipAttempt(BOARD_WS, ["c1"], "ship", { refused: atMerge("main", "notes.txt") });
    });
    const now = () => screen.getByRole("region", { name: "Now" });
    await waitFor(() => expect(screen.getAllByText("Ship stopped: local main can't be updated.").length).toBeGreaterThan(0));
    await waitFor(() => expect(line()).not.toBeNull());
    await user.click(within(line()!).getByRole("button", { name: "Bring in main's changes" }));
    await waitFor(() => expect(within(now()).getByRole("button", { name: "Fix with the Builder" })).toBeTruthy());
    expect(screen.queryByText("Ship stopped: local main can't be updated.")).toBeNull();
    expect(shipRefusedFor(useErrorBlocks.getState().byWorkspace, BOARD_WS, "c1")).toBe(false);
  });

  it("a bring-in's conflict reads as one, with Ask the Builder and no Ship again", async () => {
    const met = built({
      reviewStatus: "conflict_blocked",
      shipConflict: { paths: ["README.md"], targetSha: "def5678", at: 2, branch: "main", sync: true },
    });
    const { user, tauri } = page(met, { cards_target_sync: reading({ conflict: true }), card_ship_conflict_undo: null });
    const now = screen.getByRole("region", { name: "Now" });
    expect(within(now).getByText("Conflict with main")).toBeTruthy();
    expect(within(now).getByText("main on GitHub changed the same lines as this card in 1 file. Nothing was merged.")).toBeTruthy();
    expect(within(now).getByRole("button", { name: "Fix with the Builder" })).toBeTruthy();
    expect(within(now).queryByRole("button", { name: "Other ways: Fix with the Builder" })).toBeNull();
    // The conflict's own words stand; the badge line stays out of it.
    expect(line()).toBeNull();
    const details = document.querySelector("[data-ply-ship-conflict-details]") as HTMLElement;
    expect(
      within(details).getByText("To resolve it yourself, merge main into the card's branch in its copy, then press Finish and check."),
    ).toBeTruthy();
    // (Challenger) Dismissable before the merge is started for the Builder.
    await user.click(screen.getByRole("button", { name: "More for this card" }));
    await user.click(screen.getByRole("menuitem", { name: /Leave main's changes out/ }));
    const sheet = screen.getByRole("dialog", { name: "Leave main's changes out?" });
    await user.click(within(sheet).getByRole("button", { name: "Leave main's changes out" }));
    await waitFor(() => expect(useToasts.getState().toasts[0]?.title).toBe("main's changes left out"));
    expect(tauri.callsOf("card_ship_conflict_undo")[0].args).toEqual({ workspaceId: BOARD_WS, cardId: "c1" });
  });

  it("an open pull request's conflict stays its pull request's, and the line asks the Builder", async () => {
    const pr = built({
      reviewStatus: "merged",
      prUrl: "https://github.com/a/b/pull/7",
      pr: {
        number: 7,
        state: "open",
        headSha: "abc1234",
        checks: "passing",
        checksTotal: 1,
        checksPassed: 1,
        checksPending: 0,
        failingChecks: [],
        mergeable: "mergeable",
        reviewDecision: "none",
        openedAt: 1,
        checkedAt: 2,
      } as KanbanCard["pr"],
      shipConflict: { paths: ["README.md"], targetSha: "def5678", at: 2, branch: "main", sync: true, reviewBefore: "merged" },
    });
    page(pr, { cards_target_sync: reading({ conflict: true }) });
    await waitFor(() => expect(line()).not.toBeNull());
    expect(within(line()!).getByText("Conflict ahead")).toBeTruthy();
    expect(within(line()!).getByText(/main on GitHub changed the same lines as this card\. Press Fix with the Builder\./)).toBeTruthy();
    expect(within(line()!).getByRole("button", { name: "Fix with the Builder" })).toBeTruthy();
    expect(within(line()!).queryByRole("button", { name: "Bring in main's changes" })).toBeNull();
    expect(screen.queryByText("Ship stopped on a conflict")).toBeNull();
    // 1.174.0 A7 (VC-2, mockups/card-done.html §2a): bordered, under Now.
    expect(within(line()!).getByRole("button", { name: "Fix with the Builder" }).className).toBe("cbtn");
  });

  // 1.174.0 A7 (VC-2, mockups/card-done.html §2b): the line's presses are
  // bordered while Now has its own filled primary; without one, Finish and
  // check may stay filled. This pins the exclusive rule onePrimary.test.ts
  // counts as one ("Card page: Now and the sync line").
  it("Finish and check is filled only when Now has no primary of its own", async () => {
    for (const nowHasPrimary of [true, false]) {
      workspace();
      const card = built();
      act(() => seedBoard([card]));
      const r = renderUi(<TargetSyncLine card={card} nowHasPrimary={nowHasPrimary} />, {
        fixtures: { cards_target_sync: reading({ merging: true }) },
      });
      r.tauri.allowUnhandled();
      await waitFor(() => expect(line()).not.toBeNull());
      const finish = within(line()!).getByRole("button", { name: "Finish and check" });
      expect(finish.classList.contains("cbtn--accent")).toBe(!nowHasPrimary);
      r.unmount();
    }
  });

  // A7 round 1: Now already saying "Conflict with main" needs no second
  // conflict word on the line; any other headline keeps it.
  it("leaves the conflict lead out when Now's headline says it", async () => {
    for (const [nowHeadline, shown] of [["Conflict with main", false], ["Ready to merge", true]] as const) {
      workspace();
      const card = built();
      act(() => seedBoard([card]));
      const r = renderUi(<TargetSyncLine card={card} nowHasPrimary nowHeadline={nowHeadline} />, {
        fixtures: { cards_target_sync: reading({ conflict: true }) },
      });
      r.tauri.allowUnhandled();
      await waitFor(() => expect(line()).not.toBeNull());
      expect(within(line()!).queryByText("Conflict ahead") != null).toBe(shown);
      r.unmount();
    }
  });
});
