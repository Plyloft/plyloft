// G1 (1.170.0): the first Ship it to GitHub on a workspace says once what
// changed — Ship it now opens a pull request that merges when its checks
// pass — with a link to the guide. 1.171.0 A3: Only on this Mac is no
// longer offered there (it strands the change off GitHub).
import { describe, expect, it } from "vitest";
import type { KanbanCard, ShipOutcome } from "../ipc";
import { OutcomeScreen, type ShipRunner } from "../components/OutcomeScreen";
import { useWorkspaces } from "../store/workspaceStore";
import { SHIP_NOTICE_BODY, SHIP_NOTICE_TITLE } from "../lib/shipVia";
import { BOARD_WS, boardCard, seedBoard } from "./boardFixtures";
import { act, renderUi, screen, tauri, waitFor, within } from "./render";

const WS = BOARD_WS;
const ROOT = "/r/lyra";

const fixtures = (hasRemote: boolean) => ({
  card_outcome: { filesChanged: 1, verifyConfigured: false, isRecon: false, reconVerdictNegative: false, hasRemote },
  improvement_proposal_state: null,
  improvement_proposal_trust_stopped: null,
  reviewer_list: [],
  verify_status: null,
  card_overlap_check: [],
  card_review_tip: null,
  ship_pending_release: { release: null, unreadable: null },
  project_try_command_get: null,
  card_review_diff: { cardId: "c1", baseBranch: "main", cardBranch: "plyloft/card-c1", files: [], generatedAt: 1 },
  workspace_mark_ship_notice_seen: null,
});

const pr: ShipOutcome = { kind: "pr", prUrl: "https://github.com/o/r/pull/9", merged: false, conflictingPaths: [], fellBack: false };

async function mount(hasRemote: boolean, seen = false) {
  useWorkspaces.setState({
    workspaces: [
      {
        id: WS,
        name: "lyra",
        cwd: ROOT,
        createdAt: 1,
        lastOpenedAt: 1,
        openFiles: [],
        activeFile: null,
        ...(seen ? { shipNoticeSeen: true } : {}),
      },
    ],
    activeId: WS,
  });
  const card = boardCard("c1", {
    title: "Dark mode",
    columnId: "complete",
    lastRunStatus: "success",
    verifyStatus: "passed",
    worktreePath: "/tmp/wt/c1",
    branchName: "plyloft/card-c1",
  } as Partial<KanbanCard>);
  act(() => seedBoard([card], { name: "lyra", cwd: ROOT }));
  // seedBoard writes the workspace again: the notice's record goes after it.
  if (seen) {
    act(() =>
      useWorkspaces.setState((s) => ({
        workspaces: s.workspaces.map((w) => (w.id === WS ? { ...w, shipNoticeSeen: true } : w)),
      })),
    );
  }
  let runner: ShipRunner | null = null;
  const r = renderUi(
    <OutcomeScreen workspaceId={WS} card={card} onShipReady={(run) => (runner = run)} />,
    { withToasts: true, fixtures: { ...fixtures(hasRemote), card_ship: pr, kanban_load: [card] } },
  );
  r.tauri.allowUnhandled();
  await waitFor(() => expect(tauri().callsOf("card_outcome").length).toBeGreaterThan(0));
  await waitFor(() => expect(runner).not.toBeNull());
  await act(async () => {});
  return { ...r, run: (mode: Parameters<ShipRunner>[0]) => runner!(mode) };
}

describe("the one-time Ship it notice (G1)", () => {
  it("is asked on the first Ship it to GitHub, with no Only on this Mac; Ship it goes on", async () => {
    const { run, user } = await mount(true);
    let pressed: Promise<void> = Promise.resolve();
    act(() => {
      pressed = run("ship_it");
    });
    const sheet = await screen.findByRole("dialog", { name: SHIP_NOTICE_TITLE });
    expect(within(sheet).getByText(SHIP_NOTICE_BODY)).toBeTruthy();
    expect(within(sheet).getByRole("button", { name: "How Ship it ships" })).toBeTruthy();
    expect(tauri().callsOf("card_ship")).toHaveLength(0);
    expect(within(sheet).queryByRole("button", { name: "Only on this Mac" })).toBeNull();
    await user.click(within(sheet).getByRole("button", { name: "Ship it" }));
    await act(async () => {
      await pressed;
    });
    expect(tauri().callsOf("card_ship")[0].args).toMatchObject({ mode: "ship_it" });
    await waitFor(() => expect(tauri().callsOf("workspace_mark_ship_notice_seen")).toHaveLength(1));
    expect(useWorkspaces.getState().workspaces[0].shipNoticeSeen).toBe(true);

    // Once per workspace: the next Ship it goes straight on.
    await act(async () => {
      await run("ship_it");
    });
    expect(screen.queryByRole("dialog", { name: SHIP_NOTICE_TITLE })).toBeNull();
    expect(tauri().callsOf("card_ship")[1].args).toMatchObject({ mode: "ship_it" });
  });

  it("Ship it in the notice ships to GitHub; Cancel ships nothing", async () => {
    const { run, user } = await mount(true);
    let pressed: Promise<void> = Promise.resolve();
    act(() => {
      pressed = run("ship_it");
    });
    const sheet = await screen.findByRole("dialog", { name: SHIP_NOTICE_TITLE });
    await user.click(within(sheet).getByRole("button", { name: "Cancel" }));
    await act(async () => {
      await pressed;
    });
    expect(tauri().callsOf("card_ship")).toHaveLength(0);
    await waitFor(() => expect(tauri().callsOf("workspace_mark_ship_notice_seen")).toHaveLength(1));
  });

  // G1 Challenger (5): a Ship it pressed before the result has loaded reads
  // it first — the notice is never skipped on a project on GitHub.
  it("is asked when Ship it is pressed while the result still loads", async () => {
    useWorkspaces.setState({
      workspaces: [{ id: WS, name: "lyra", cwd: ROOT, createdAt: 1, lastOpenedAt: 1, openFiles: [], activeFile: null }],
      activeId: WS,
    });
    const card = boardCard("c1", {
      title: "Dark mode",
      columnId: "complete",
      lastRunStatus: "success",
      verifyStatus: "passed",
      worktreePath: "/tmp/wt/c1",
      branchName: "plyloft/card-c1",
    } as Partial<KanbanCard>);
    act(() => seedBoard([card], { name: "lyra", cwd: ROOT }));
    let reads = 0;
    let runner: ShipRunner | null = null;
    const loaded = fixtures(true).card_outcome;
    const r = renderUi(
      <OutcomeScreen workspaceId={WS} card={card} onShipReady={(run) => (runner = run)} />,
      {
        withToasts: true,
        fixtures: {
          ...fixtures(true),
          // The screen's own read never answers; the press's read does.
          card_outcome: () => (reads++ === 0 ? new Promise(() => {}) : loaded),
          card_ship: pr,
          kanban_load: [card],
        },
      },
    );
    r.tauri.allowUnhandled();
    await waitFor(() => expect(runner).not.toBeNull());
    let pressed: Promise<void> = Promise.resolve();
    act(() => {
      pressed = runner!("ship_it");
    });
    const sheet = await screen.findByRole("dialog", { name: SHIP_NOTICE_TITLE });
    await r.user.click(within(sheet).getByRole("button", { name: "Ship it" }));
    await act(async () => {
      await pressed;
    });
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(tauri().callsOf("card_ship")[0].args).toMatchObject({ mode: "ship_it" });
  });

  it("is not asked where Ship it lands here", async () => {
    const off = await mount(false);
    await act(async () => {
      await off.run("ship_it");
    });
    expect(screen.queryByRole("dialog", { name: SHIP_NOTICE_TITLE })).toBeNull();
    expect(tauri().callsOf("card_ship")[0].args).toMatchObject({ mode: "ship_it" });
  });

  it("is not asked once seen, nor for the other presses", async () => {
    const seen = await mount(true, true);
    await act(async () => {
      await seen.run("ship_it");
    });
    expect(screen.queryByRole("dialog", { name: SHIP_NOTICE_TITLE })).toBeNull();
    await act(async () => {
      await seen.run("pr_only");
    });
    expect(tauri().callsOf("card_ship").map((c) => c.args.mode)).toEqual(["ship_it", "pr_only"]);
  });
});

// 1.173.0 (G1): How Ship it ships is in Settings › Shipping now; its rows
// are tested in shippingPage.test.tsx.

