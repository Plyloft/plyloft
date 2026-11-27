// 1.176.2 F2: the card's outward presses go once when they arrive twice in
// the same tick — from the card's Shipping section and its Now (both call the
// actions this section hands out), or from the Inbox row. React's `busy`
// state can't stop that: both calls read it from before. Only Tauri is a
// stub.
import { afterEach, describe, expect, it, vi } from "vitest";
import { CardShipStep } from "../components/CardShipStep";
import type { PrActions } from "../components/CardShipStep";
import { mergeFromInbox } from "../components/InboxPanel";
import { SharedSetupRow } from "../components/RepositorySettings";
import type { KanbanCard, PrMergeResult, PrStatus } from "../ipc";
import type { AdoptionStatus } from "../lib/adoption";
import { shareSetupAgain, stopSharingSetup } from "../components/AdoptionBanner";
import { useKanban } from "../store/kanbanStore";
import { useWorkMode } from "../store/workModeStore";
import { act, renderUi, screen, waitFor, within } from "./render";
import { BOARD_WS, seedBoard } from "./boardFixtures";

const WS = "ws-1";

afterEach(() => {
  vi.restoreAllMocks();
});

/** The clock moved on by `ms` (only `Date.now`, which the press slot reads). */
function clockAhead(ms: number) {
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + ms);
}
const pr = (patch: Partial<PrStatus> = {}): PrStatus => ({
  number: 12,
  state: "open",
  checks: "pending",
  checksTotal: 1,
  checksPassed: 0,
  checksPending: 1,
  failingChecks: [],
  mergeable: "mergeable",
  reviewDecision: "none",
  openedAt: 1,
  checkedAt: 2,
  ...patch,
});
const card: KanbanCard = {
  id: "card-1",
  workspaceId: WS,
  title: "Add sum",
  columnId: "in_progress",
  lastRunStatus: "success",
  verifyStatus: "passed",
  reviewStatus: "merged",
  prUrl: "https://github.com/o/r/pull/12",
  pr: pr({ autoMerge: true }),
  worktreePath: "/tmp/ply-test/card-1",
  branchName: "card/card-1",
  createdAt: 1,
  updatedAt: 1,
};
const quiet = { improvement_proposal_state: null, improvement_proposal_trust_stopped: null, ship_pending_release: null };

/** A command that answers only when the test lets it. */
function held<T>(answer: T) {
  const waiting: (() => void)[] = [];
  return {
    fixture: () => new Promise<T>((resolve) => waiting.push(() => resolve(answer))),
    let: () => waiting.splice(0).forEach((go) => go()),
  };
}

function renderStep(fixtures: Record<string, unknown>) {
  useKanban.setState({ byWorkspace: { [WS]: { cards: [card], loaded: true } } } as never);
  let actions: PrActions | null = null;
  const r = renderUi(<CardShipStep card={card} onOpenRelease={() => {}} onPrActionsReady={(a) => (actions = a)} />, {
    fixtures: { ...quiet, card_pr_refresh: card, ...fixtures },
  });
  return { ...r, actions: () => actions! };
}

describe("a card's pull request presses go once (1.176.2 F2)", () => {
  it("Merge twice in the same tick: one card_pr_merge; free again after", async () => {
    const merged: PrMergeResult = { card, merged: false, refused: "Not mergeable yet." };
    const answer = held(merged);
    const r = renderStep({ card_pr_merge: answer.fixture });
    await waitFor(() => expect(r.actions()).not.toBeNull());
    let runs: Promise<unknown>[] = [];
    act(() => {
      runs = [r.actions().merge(), r.actions().mergeGitHubHead()];
    });
    expect(r.tauri.callsOf("card_pr_merge")).toHaveLength(1);
    await act(async () => {
      answer.let();
      await Promise.all(runs);
    });
    // A refusal frees the slot: the next press goes.
    await act(async () => {
      const next = r.actions().merge();
      answer.let();
      await next;
    });
    await waitFor(() => expect(r.tauri.callsOf("card_pr_merge")).toHaveLength(2));
  });

  it("the card's Merge and the Inbox row's Merge in the same tick: one card_pr_merge", async () => {
    const answer = held<PrMergeResult>({ card, merged: false, refused: "Not mergeable yet." });
    const r = renderStep({ card_pr_merge: answer.fixture });
    await waitFor(() => expect(r.actions()).not.toBeNull());
    let runs: Promise<unknown>[] = [];
    act(() => {
      runs = [mergeFromInbox(WS, card.id), r.actions().merge()];
    });
    expect(r.tauri.callsOf("card_pr_merge")).toHaveLength(1);
    await act(async () => {
      answer.let();
      await Promise.all(runs);
    });
    r.tauri.allowUnhandled();
  });

  it("Turn off (Merge when checks pass) twice in the same tick: one card_pr_set_auto_merge", async () => {
    const answer = held<PrMergeResult>({ card: { ...card, pr: pr() }, merged: false });
    const r = renderStep({ card_pr_set_auto_merge: answer.fixture });
    await waitFor(() => expect(r.actions()).not.toBeNull());
    let runs: Promise<unknown>[] = [];
    act(() => {
      runs = [r.actions().autoMergeOff(), r.actions().autoMergeOff()];
    });
    expect(r.tauri.callsOf("card_pr_set_auto_merge")).toHaveLength(1);
    await act(async () => {
      answer.let();
      await Promise.all(runs);
    });
  });

  it("Send the fixes to GitHub twice in the same tick: one card_pr_push_update; free again after an error", async () => {
    let n = 0;
    const waiting: ((v: unknown) => void)[] = [];
    const r = renderStep({
      card_pr_push_update: () => {
        n += 1;
        if (n === 1) return new Promise((_, reject) => waiting.push(reject));
        return { card, pushed: true };
      },
    });
    await waitFor(() => expect(r.actions()).not.toBeNull());
    let runs: Promise<unknown>[] = [];
    act(() => {
      runs = [r.actions().pushUpdate(), r.actions().pushUpdate()];
    });
    expect(r.tauri.callsOf("card_pr_push_update")).toHaveLength(1);
    await act(async () => {
      waiting.forEach((reject) => reject("network down"));
      await Promise.all(runs);
    });
    await act(async () => {
      await r.actions().pushUpdate();
    });
    expect(r.tauri.callsOf("card_pr_push_update")).toHaveLength(2);
  });
});

describe("Stop sharing goes once (1.176.2 F2)", () => {
  const status = (): AdoptionStatus => ({
    githubRepo: "mbadv/lyra",
    hasDefinition: true,
    boardRepo: "mbadv/lyra",
    action: { kind: "none" },
    sharedSetup: { state: "shared", branch: "staging", readOnly: false, author: "example-teammate", pending: [], pullRequest: null },
  });

  it("two presses in the same tick: one question, one workspace_stop_sharing; free again after", async () => {
    act(() => seedBoard([]));
    act(() => useWorkMode.setState({ mode: "team", chosen: true }));
    const r = renderUi(<SharedSetupRow workspaceId={BOARD_WS} offline={false} />, {
      fixtures: {
        workspace_adoption_status: () => status(),
        workspace_stop_sharing: () => ({ kind: "stopped", branch: "staging" }),
      },
      withToasts: true,
    });
    r.tauri.allowUnhandled();
    await screen.findByRole("button", { name: "Stop sharing…" });
    const setup = status().sharedSetup as Extract<AdoptionStatus["sharedSetup"], { state: "shared" }>;
    let runs: Promise<boolean>[] = [];
    act(() => {
      runs = [stopSharingSetup(BOARD_WS, setup), stopSharingSetup(BOARD_WS, setup)];
    });
    const sheets = await screen.findAllByRole("dialog", { name: "Stop sharing this project's setup?" });
    expect(sheets).toHaveLength(1);
    await r.user.click(within(sheets[0]).getByRole("button", { name: "Stop sharing" }));
    let answers: boolean[] = [];
    await act(async () => {
      answers = await Promise.all(runs);
    });
    expect(answers).toEqual([true, false]);
    expect(r.tauri.callsOf("workspace_stop_sharing")).toHaveLength(1);
    // Free again: a later press asks again (Keep sharing: nothing written).
    // While that question is up, a press seconds later says it is running.
    let later: Promise<boolean> = Promise.resolve(false);
    act(() => {
      later = stopSharingSetup(BOARD_WS, setup);
    });
    const again = await screen.findByRole("dialog", { name: "Stop sharing this project's setup?" });
    clockAhead(5_000);
    await act(async () => {
      expect(await stopSharingSetup(BOARD_WS, setup)).toBe(false);
    });
    expect(await screen.findByText("Stop sharing is still running.")).toBeTruthy();
    expect(screen.getAllByRole("dialog", { name: "Stop sharing this project's setup?" })).toHaveLength(1);
    await r.user.click(within(again).getByRole("button", { name: "Keep sharing" }));
    await act(async () => {
      expect(await later).toBe(false);
    });
    expect(r.tauri.callsOf("workspace_stop_sharing")).toHaveLength(1);
  });
});

// Review M2: a press well after the running one is answered.
describe("a press while the same one runs says so (review M2)", () => {
  it("the Inbox row's Merge while the card's Merge runs: no second call, and it says the merge is still running", async () => {
    const answer = held<PrMergeResult>({ card, merged: false, refused: "Not mergeable yet." });
    const r = renderStep({ card_pr_merge: answer.fixture });
    await waitFor(() => expect(r.actions()).not.toBeNull());
    let first: Promise<unknown> = Promise.resolve();
    act(() => {
      first = r.actions().merge();
    });
    clockAhead(5_000);
    renderUi(<></>, { withToasts: true });
    await act(async () => {
      await mergeFromInbox(WS, card.id);
    });
    expect(r.tauri.callsOf("card_pr_merge")).toHaveLength(1);
    expect(await screen.findByText("That merge is still running.")).toBeTruthy();
    await act(async () => {
      answer.let();
      await first;
    });
  });
});

describe("Share it again goes once (1.176.2 F2, review F3)", () => {
  it("two presses in the same tick: one question, one workspace_adoption_share", async () => {
    act(() => seedBoard([]));
    act(() => useWorkMode.setState({ mode: "team", chosen: true }));
    const notShared = { state: "notShared", who: "example-teammate", at: Math.floor(Date.now() / 1000) - 7200, here: false, readOnly: false };
    const status = { githubRepo: "mbadv/lyra", boardRepo: "mbadv/lyra", sharedSetup: notShared } as never;
    const r = renderUi(<SharedSetupRow workspaceId={BOARD_WS} offline={false} />, {
      fixtures: {
        workspace_adoption_status: () => ({ ...(status as object), hasDefinition: true, action: { kind: "none" } }),
        workspace_adoption_share: () => ({ alreadyShared: false, board: "local", localCards: 0, boardHeld: null }),
      },
      withToasts: true,
    });
    r.tauri.allowUnhandled();
    await screen.findByRole("button", { name: "Share it again…" });
    act(() => {
      void shareSetupAgain(BOARD_WS, status);
      void shareSetupAgain(BOARD_WS, status);
    });
    const sheets = await screen.findAllByRole("dialog", { name: "Share this project's setup again?" });
    expect(sheets).toHaveLength(1);
    await r.user.click(within(sheets[0]).getByRole("button", { name: "Share it again" }));
    await waitFor(() => expect(r.tauri.callsOf("workspace_adoption_share")).toHaveLength(1));
    expect(screen.queryAllByRole("dialog", { name: "Share this project's setup again?" })).toHaveLength(0);
  });
});
