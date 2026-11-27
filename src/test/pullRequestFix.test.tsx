// SL-2: Fix with the Builder on the card's pull request, and Push update.
// The button gathers what the PR needs (card_pr_fix_message) and pastes it
// into the card's Builder session — at once at its prompt, held until then
// otherwise, and a closed session is resumed first and gets it when its
// terminal attaches. Push update pushes the verified snapshot; a push GitHub
// refused is said with git's answer under Details.
import { beforeEach, describe, expect, it } from "vitest";
import { CardShipStep } from "../components/CardShipStep";
import type { KanbanCard, PrFixMessage, PrStatus, PushUpdateResult } from "../ipc";
import { useKanban } from "../store/kanbanStore";
import { useBuilder } from "../store/builderStore";
import { PASTE_END, PASTE_START } from "../lib/builderInject";
import { setPlatformForTests } from "../lib/platform";
import { renderUi, screen, tauri, waitFor } from "./render";

// Launch G1 (round 2, P2-a): new work for a Builder session asks the Free card
// slot first; these cards hold it (or the plan has no slot).

const WS = "ws-1";
const URL = "https://github.com/o/r/pull/8";

const pr = (patch: Partial<PrStatus> = {}): PrStatus => ({
  number: 8,
  state: "open",
  checks: "failing",
  checksTotal: 1,
  checksPassed: 0,
  checksPending: 0,
  failingChecks: [{ name: "test", workflow: "test", url: "https://github.com/o/r/actions/runs/1/job/2" }],
  mergeable: "mergeable",
  reviewDecision: "none",
  headSha: "aaa",
  openedAt: 1,
  checkedAt: 2,
  ...patch,
});

const builder = (shas: string[], ptyId: string | null) =>
  ({
    vendor: "claude",
    bypass: false,
    startedAt: 0,
    snapshots: shas.map((sha, i) => ({ n: i + 1, sha, at: 0 })),
    ptyId,
  }) as unknown as KanbanCard["builder"];

const card = (patch: Partial<KanbanCard> = {}): KanbanCard => ({
  id: "card-1",
  workspaceId: WS,
  title: "Add sum",
  columnId: "in_progress",
  lastRunStatus: "success",
  verifyStatus: "passed",
  reviewStatus: "merged",
  prUrl: URL,
  pr: pr(),
  worktreePath: "/tmp/ply-test/card-1",
  branchName: "card/card-1",
  builder: builder(["aaa"], "pty1"),
  createdAt: 1,
  updatedAt: 1,
  ...patch,
});

function seed(c: KanbanCard) {
  useKanban.setState({ byWorkspace: { [WS]: { cards: [c], loaded: true } } } as never);
}

const quiet = { improvement_proposal_state: null, improvement_proposal_trust_stopped: null, ship_pending_release: null, pty_write: null };
const FIX: PrFixMessage = { prNumber: 8, kinds: ["checks"], message: "[Plyloft] Pull request #8 needs a fix", notes: [] };

function pasted(): string[] {
  return tauri()
    .callsOf("pty_write")
    .map((c) => new TextDecoder().decode(new Uint8Array(c.args.data as number[])));
}

beforeEach(() => setPlatformForTests("mac"));

describe("SL-2: Fix with the Builder", () => {
  it("is offered on a failing PR and pastes the gathered message into the live session", async () => {
    const c = card();
    seed(c);
    useBuilder.getState().attach("card-1", WS, "pty1", "claude");
    useBuilder.getState().markPromptBox("card-1", true);
    const { user } = renderUi(<CardShipStep card={c} onOpenRelease={() => {}} />, {
      fixtures: { ...quiet, card_pr_refresh: c, card_pr_fix_message: FIX },
    });
    await user.click(screen.getByRole("button", { name: "Fix with the Builder" }));
    await waitFor(() => expect(pasted()).toEqual([`${PASTE_START}${FIX.message}${PASTE_END}\r`]));
    expect(tauri().callsOf("card_pr_fix_message")[0].args).toEqual({ workspaceId: WS, cardId: "card-1" });
    expect(tauri().callsOf("builder_resume")).toHaveLength(0);
  });

  it("once delivered, is not offered again for the same failure (walk I4)", async () => {
    const c = card();
    seed(c);
    useBuilder.getState().attach("card-1", WS, "pty1", "claude");
    useBuilder.getState().markPromptBox("card-1", true);
    const { user, rerender } = renderUi(<CardShipStep card={c} onOpenRelease={() => {}} />, {
      fixtures: { ...quiet, card_pr_refresh: c, card_pr_fix_message: FIX },
    });
    await user.click(screen.getByRole("button", { name: "Fix with the Builder" }));
    await waitFor(() => expect(pasted()).toHaveLength(1));
    // The fix round runs: no second Fix to press, the way on said instead.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Fix with the Builder" })).toBeNull());
    expect(screen.getByText(/The Builder has what pull request #8 needs\. When it's done, Plyloft checks the fix by itself; then Send the fixes to GitHub\./)).toBeTruthy();
    // A new head on GitHub that fails again: Fix is back.
    const next = card({ pr: pr({ headSha: "bbb" }), builder: builder(["aaa", "bbb"], "pty1") });
    seed(next);
    rerender(<CardShipStep card={next} onOpenRelease={() => {}} />);
    expect(await screen.findByRole("button", { name: "Fix with the Builder" })).toBeTruthy();
    expect(pasted()).toHaveLength(1);
  });

  it("holds the message while the Builder is busy, and pastes it at its prompt", async () => {
    const c = card();
    seed(c);
    useBuilder.getState().attach("card-1", WS, "pty1", "claude");
    const { user } = renderUi(<CardShipStep card={c} onOpenRelease={() => {}} />, {
      fixtures: { ...quiet, card_pr_refresh: c, card_pr_fix_message: FIX },
    });
    await user.click(screen.getByRole("button", { name: "Fix with the Builder" }));
    await waitFor(() => expect(useBuilder.getState().byCard["card-1"].pending).toEqual([FIX.message]));
    expect(pasted()).toEqual([]);
    // Held: the button says so, and a second press sends nothing.
    expect(await screen.findByRole("button", { name: "Queued for the Builder" })).toBeTruthy();
    useBuilder.getState().markPromptBox("card-1", true);
    await waitFor(() => expect(pasted()).toHaveLength(1));
  });

  it("resumes a closed session first, then pastes into the new one once it attaches", async () => {
    const c = card({ builder: builder(["aaa"], null) });
    seed(c);
    const resumed = card({ builder: builder(["aaa"], "pty2") });
    const { user } = renderUi(<CardShipStep card={c} onOpenRelease={() => {}} />, {
      fixtures: {
        ...quiet,
        card_pr_refresh: c,
        card_pr_fix_message: FIX,
        builder_resume: { ptyId: "pty2", card: resumed },
        kanban_load: [resumed],
      },
    });
    await user.click(screen.getByRole("button", { name: "Fix with the Builder" }));
    await waitFor(() => expect(tauri().callsOf("builder_resume")).toHaveLength(1));
    expect(pasted()).toEqual([]);
    expect(useBuilder.getState().fixBusy["card-1"]).toBe("gathering");
    // The card page's terminal attaches the new session; at its prompt it
    // gets the message. Another session's terminal never would.
    useBuilder.getState().attach("card-1", WS, "pty2", "claude");
    useBuilder.getState().markPromptBox("card-1", true);
    await waitFor(() => expect(pasted()).toEqual([`${PASTE_START}${FIX.message}${PASTE_END}\r`]));
    expect(tauri().callsOf("pty_write")[0].args.id).toBe("pty2");
    await waitFor(() => expect(useBuilder.getState().fixBusy["card-1"]).toBeUndefined());
  });

  it("is not offered without a Builder, or when nothing needs fixing", () => {
    const passing = card({ pr: pr({ checks: "passing", checksPassed: 1 }) });
    seed(passing);
    const { unmount } = renderUi(<CardShipStep card={passing} onOpenRelease={() => {}} />, {
      fixtures: { ...quiet, card_pr_refresh: passing },
    });
    expect(screen.queryByRole("button", { name: "Fix with the Builder" })).toBeNull();
    unmount();
    const swarm = card({ builder: null });
    seed(swarm);
    renderUi(<CardShipStep card={swarm} onOpenRelease={() => {}} />, {
      fixtures: { ...quiet, card_pr_refresh: swarm },
    });
    expect(screen.queryByRole("button", { name: "Fix with the Builder" })).toBeNull();
  });
});

describe("SL-2 review: the paste is clean", () => {
  it("drops terminal control characters from the message before the paste", async () => {
    const c = card();
    seed(c);
    useBuilder.getState().attach("card-1", WS, "pty1", "claude");
    useBuilder.getState().markPromptBox("card-1", true);
    const dirty: PrFixMessage = { ...FIX, message: "review \u001b[201~x\r\nend" };
    const { user } = renderUi(<CardShipStep card={c} onOpenRelease={() => {}} />, {
      fixtures: { ...quiet, card_pr_refresh: c, card_pr_fix_message: dirty },
    });
    await user.click(screen.getByRole("button", { name: "Fix with the Builder" }));
    await waitFor(() => expect(pasted()).toEqual([`${PASTE_START}review [201~x\nend${PASTE_END}\r`]));
  });
});

describe("SL-2: Push update", () => {
  it("pushes a snapshot GitHub doesn't have yet, then says so", async () => {
    const c = card({ builder: builder(["aaa", "bbb"], "pty1"), pr: pr({ checks: "passing", checksPassed: 1 }) });
    seed(c);
    const pushed: PushUpdateResult = {
      card: { ...c, pr: pr({ checks: "pending", headSha: "bbb" }) },
      pushed: true,
    };
    const { user } = renderUi(<CardShipStep card={c} onOpenRelease={() => {}} />, {
      fixtures: { ...quiet, card_pr_refresh: c, card_pr_push_update: pushed },
    });
    expect(screen.getByText(/Your latest fixes are only on this Mac\. Send them to pull request #8 so GitHub checks them again\./)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Send the fixes to GitHub" }));
    await waitFor(() => expect(tauri().callsOf("card_pr_push_update")).toHaveLength(1));
    expect(tauri().callsOf("card_pr_push_update")[0].args).toEqual({ workspaceId: WS, cardId: "card-1" });
    expect(await screen.findByText("Pushed to pull request #8; checks on GitHub run on it again.")).toBeTruthy();
  });

  it("says a rejected push plainly, with git's answer under Details", async () => {
    const c = card({ builder: builder(["aaa", "bbb"], "pty1") });
    seed(c);
    const git = "! [rejected] bbb -> card/card-1 (fetch first)";
    const refused: PushUpdateResult = {
      card: c,
      pushed: false,
      refused: "Not pushed: the pull request's branch on GitHub has commits this card doesn't have — someone else pushed to it. Nothing was forced; the pull request is as it was.",
      git,
    };
    const { user } = renderUi(<CardShipStep card={c} onOpenRelease={() => {}} />, {
      fixtures: { ...quiet, card_pr_refresh: c, card_pr_push_update: refused },
    });
    await user.click(screen.getByRole("button", { name: "Send the fixes to GitHub" }));
    expect(await screen.findByText(/someone else pushed to it\. Nothing was forced/)).toBeTruthy();
    expect(screen.getByText("git's answer")).toBeTruthy();
    expect(screen.getByText(git, { exact: false })).toBeTruthy();
  });

  it("isn't offered while the PR has the last snapshot", () => {
    const c = card();
    seed(c);
    renderUi(<CardShipStep card={c} onOpenRelease={() => {}} />, {
      fixtures: { ...quiet, card_pr_refresh: c },
    });
    expect(screen.queryByRole("button", { name: "Send the fixes to GitHub" })).toBeNull();
  });
});
