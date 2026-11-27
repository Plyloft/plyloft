// Skills hub H6b (Windows walk): a Sync that finds the local target and
// GitHub's both moved says where new cards start — and that a skill card
// starts from the local one (`worktrees::resolve_skill_base`), where its ship
// lands, not from GitHub's as every other card does. The words go through the
// toast's `machineWords`, so Windows says "this PC's".
import { beforeEach, describe, expect, it } from "vitest";
import type { ReconcileSummary } from "../ipc";
import { setPlatformForTests } from "../lib/platform";
import { useKanban } from "../store/kanbanStore";
import { useToasts } from "../store/toastStore";
import { useWorkspaces } from "../store/workspaceStore";
import { act, tauri } from "./render";

const WS = "ws-1";

const summary: ReconcileSummary = {
  created: 0,
  patched: 0,
  missing: [],
  prunedWorktrees: 0,
  localBranch: { branch: "walk-1014", outcome: { kind: "diverged", ahead: 2, behind: 1 } },
};

async function sync(): Promise<string | undefined> {
  useWorkspaces.setState({
    workspaces: [{ id: WS, name: "Ply", cwd: "/tmp/ply-test", kanbanSyncMode: "githubIssues" } as never],
    activeId: WS,
  });
  const stub = tauri();
  stub.allowUnhandled();
  stub.fixture("kanban_github_reconcile", summary);
  await act(async () => {
    await useKanban.getState().reconcileGithub(WS);
  });
  return useToasts.getState().toasts.find((t) => t.title === "walk-1014 on this Mac and on GitHub have both moved" || t.title === "walk-1014 on this PC and on GitHub have both moved")?.body;
}

describe("a diverged Sync says where a skill card starts (H6b Windows walk)", () => {
  // E3: a Sync nobody pressed says a lasting state once; each test is a
  // first time.
  beforeEach(() => {
    try {
      localStorage.clear();
    } catch {
      /* no storage */
    }
  });
  it("on the Mac", async () => {
    const body = await sync();
    expect(body).toBe(
      "Plyloft won't combine them: new cards start from GitHub's walk-1014, a skill card from this Mac's, where its ship lands.",
    );
  });

  it("on Windows", async () => {
    setPlatformForTests("windows");
    const body = await sync();
    expect(body).toContain("a skill card from this PC's, where its ship lands.");
    expect(body).not.toMatch(/\bMac\b/);
  });
});
