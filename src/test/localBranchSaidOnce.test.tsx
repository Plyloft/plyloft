// E3 (owner, 2026-10-28): after an update the owner met "staging on this Mac
// is behind GitHub … Commit or undo them, then Sync again. · 1 more" at
// launch, unasked, every time. Now a Sync nobody pressed says a lasting
// local-branch state once per workspace, branch and state; Settings › Board
// and worktrees keeps it with the same press; the toast's press opens the
// folder's changed files instead of telling the person to go and find them.
// F1 (1.172.1): the state is the project folder's ask now ("Your project
// folder is from 16 Sep"), its presses Bring it up to date and I don't work
// here; the changes sheet replaced opening the files (projectFolderAsk.test).
import { beforeEach, describe, expect, it } from "vitest";
import type { ReconcileSummary } from "../ipc";
import { LocalBranchState } from "../components/errors/LocalBranchState";
import { useErrorBlocks } from "../store/errorBlockStore";
import { useKanban } from "../store/kanbanStore";
import { useToasts } from "../store/toastStore";
import { useWorkspaces } from "../store/workspaceStore";
import { act, renderUi, screen, tauri } from "./render";

const WS = "ws-e3";
const TITLE = "Your project folder is from 16 Sep";
const SEP16 = Math.floor(new Date(new Date().getFullYear(), 8, 16, 12).getTime() / 1000);

const summary = (behind: number): ReconcileSummary => ({
  created: 0,
  patched: 0,
  missing: [],
  prunedWorktrees: 0,
  localBranch: {
    branch: "staging",
    outcome: { kind: "dirty", behind },
    folder: {
      branch: "staging",
      head: "a".repeat(40),
      headAt: SEP16,
      targetLocal: "a".repeat(40),
      targetRemote: "b".repeat(40),
      newer: behind,
      onlyHere: 0,
      changedCount: 2,
      changedPaths: ["CONTEXT.md", ".claude/settings.json"],
    },
  },
});

function seed() {
  useWorkspaces.setState({
    workspaces: [{ id: WS, name: "Ply", cwd: "/tmp/ply-e3", kanbanSyncMode: "githubIssues" } as never],
    activeId: WS,
  });
}

async function sync(behind: number, manual = false) {
  const stub = tauri();
  stub.allowUnhandled();
  stub.fixture("kanban_github_reconcile", summary(behind));
  await act(async () => {
    await useKanban.getState().reconcileGithub(WS, manual ? { manual: true } : undefined);
  });
  return stub;
}

// Recent messages folds the same message said again into ×N.
const saidTimes = () =>
  useToasts
    .getState()
    .recent.filter((t) => t.title === TITLE)
    .reduce((n, t) => n + (t.times ?? 1), 0);

describe("a lasting local-branch state is said once, and kept on its page (E3)", () => {
  beforeEach(() => {
    try {
      localStorage.clear();
    } catch {
      /* no storage: nothing to clear */
    }
    useErrorBlocks.setState({ byWorkspace: {} });
    seed();
  });

  it("says it on the first Sync nobody pressed, not on the next ones", async () => {
    await sync(527);
    expect(saidTimes()).toBe(1);
    const toast = useToasts.getState().toasts[0];
    expect(toast.title).toBe(TITLE);
    expect(toast.kind).toBe("info");
    expect(toast.body).toBe(
      "It's on staging, with 2 changes not saved in Git yet. GitHub's staging has 527 newer updates. Your cards always start from GitHub, so they aren't affected — only Code and terminals opened here show the old version.",
    );
    expect(toast.action?.label).toBe("Bring it up to date");
    expect(toast.secondaryAction?.label).toBe("I don't work here");
    expect(toast.details).toContain("Changed files (2): CONTEXT.md, .claude/settings.json");
    // The next launch, a few more updates on GitHub: the same state, quiet.
    await sync(530);
    expect(saidTimes()).toBe(1);
    // Kept on the page all along.
    expect(useErrorBlocks.getState().byWorkspace[WS]?.localState?.outcome).toEqual({ kind: "dirty", behind: 530 });
    expect(useErrorBlocks.getState().byWorkspace[WS]?.localState?.folder?.newer).toBe(530);
  });

  it("says it again on a Sync the person pressed", async () => {
    await sync(527);
    await sync(527, true);
    expect(saidTimes()).toBe(2);
  });

  it("forgets it once it is gone, so it is said when it comes back", async () => {
    await sync(527);
    const stub = tauri();
    stub.allowUnhandled();
    stub.fixture("kanban_github_reconcile", {
      ...summary(0),
      localBranch: { branch: "staging", outcome: { kind: "upToDate" } },
    });
    await act(async () => {
      await useKanban.getState().reconcileGithub(WS);
    });
    expect(useErrorBlocks.getState().byWorkspace[WS]?.localState ?? null).toBeNull();
    await sync(3);
    expect(saidTimes()).toBe(2);
  });

  it("an offline launch neither clears the notice nor says it again (Reviewer 3)", async () => {
    await sync(527);
    const stub = tauri();
    stub.allowUnhandled();
    stub.fixture("kanban_github_reconcile", {
      ...summary(0),
      localBranch: { branch: "staging", outcome: { kind: "offline", reason: "no network" } },
    });
    await act(async () => {
      await useKanban.getState().reconcileGithub(WS);
    });
    expect(useErrorBlocks.getState().byWorkspace[WS]?.localState?.outcome.kind).toBe("dirty");
    await sync(527);
    expect(saidTimes()).toBe(1);
  });

  it("the Board shows the folder's state, not both-moved (round 3)", () => {
    useErrorBlocks.getState().setLocalState(WS, { branch: "staging", outcome: { kind: "diverged", ahead: 1, behind: 2 } });
    const board = renderUi(<LocalBranchState workspaceId={WS} on="board" />);
    expect(board.container.textContent).toBe("");
    board.unmount();
    renderUi(<LocalBranchState workspaceId={WS} />);
    expect(screen.getByText("staging on this Mac and on GitHub have both moved")).toBeTruthy();
  });

  it("no local target branch takes an old notice down (F1, item 2)", async () => {
    await sync(527);
    const stub = tauri();
    stub.allowUnhandled();
    stub.fixture("kanban_github_reconcile", {
      ...summary(0),
      localBranch: { branch: "staging", outcome: { kind: "noLocalBranch" } },
    });
    await act(async () => {
      await useKanban.getState().reconcileGithub(WS);
    });
    expect(useErrorBlocks.getState().byWorkspace[WS]?.localState ?? null).toBeNull();
    // Forgotten too: said again when it comes back.
    await sync(3);
    expect(saidTimes()).toBe(2);
  });
});
