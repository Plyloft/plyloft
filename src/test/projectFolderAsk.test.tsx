// F1 (1.172.1, owner 2026-10-28): "Your project folder is behind GitHub —
// … 532 newer updates" for a folder that sat on main while cards used
// staging, with no local staging, and a clean git status. Now the Board says
// what the folder is and asks once: Bring it up to date, or I don't work here
// (persisted per workspace); changes in the way open the changes sheet, whose
// Ask Claude to save them opens a Claude tile with the request typed.
import { beforeEach, describe, expect, it } from "vitest";
import type { FolderFacts, ReconcileSummary } from "../ipc";
import { LocalBranchState } from "../components/errors/LocalBranchState";
import { FolderChangesSheet } from "../components/FolderChangesSheet";
import { FolderVersionLine } from "../components/FolderVersionLine";
import { useErrorBlocks } from "../store/errorBlockStore";
import { useKanban } from "../store/kanbanStore";
import { useProjectFolder } from "../store/projectFolderStore";
import { useTiles } from "../store/tileStore";
import { useToasts } from "../store/toastStore";
import { useWorkspaces } from "../store/workspaceStore";
import { act, renderUi, screen, tauri } from "./render";

const WS = "ws-lyra";
const CWD = "/tmp/lyra-jun-2025";
const SEP16 = Math.floor(new Date(new Date().getFullYear(), 8, 16, 12).getTime() / 1000);
const TITLE = "Your project folder is from 16 Sep";
const BODY =
  "It's on main. GitHub's staging has 695 newer updates. Your cards always start from GitHub, so they aren't affected — only Code and terminals opened here show the old version.";

const folder = (over: Partial<FolderFacts> = {}): FolderFacts => ({
  branch: "main",
  head: "a".repeat(40),
  headAt: SEP16,
  targetLocal: null,
  targetRemote: "b".repeat(40),
  newer: 695,
  onlyHere: 0,
  changedCount: 0,
  changedPaths: [],
  ...over,
});

const lyra = (over: Partial<FolderFacts> = {}): ReconcileSummary => ({
  created: 0,
  patched: 0,
  missing: [],
  prunedWorktrees: 0,
  localBranch: { branch: "staging", outcome: { kind: "noLocalBranch" }, folder: folder(over) },
});

function seed(dontWorkHere = false) {
  useWorkspaces.setState({
    workspaces: [{ id: WS, name: "LYRA - Jun 2025", cwd: CWD, kanbanSyncMode: "githubIssues", dontWorkHere } as never],
    activeId: WS,
  });
}

async function sync(summary: ReconcileSummary, manual = false) {
  const stub = tauri();
  stub.allowUnhandled();
  stub.fixture("kanban_github_reconcile", summary);
  await act(async () => {
    await useKanban.getState().reconcileGithub(WS, manual ? { manual: true } : undefined);
  });
  return stub;
}

const settle = async () => {
  await act(async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  });
};

const told = (title: string) => useToasts.getState().recent.filter((t) => t.title === title).length;

describe("the project folder's ask (F1)", () => {
  beforeEach(() => {
    try {
      localStorage.clear();
    } catch {
      /* no storage */
    }
    useErrorBlocks.setState({ byWorkspace: {} });
    useProjectFolder.setState({ sheetFor: null, answered: {} });
    seed();
  });

  it("a folder on another branch hears what it is, never that it is behind", async () => {
    await sync(lyra());
    const toast = useToasts.getState().toasts[0];
    expect(toast.kind).toBe("info");
    expect(toast.title).toBe(TITLE);
    expect(toast.body).toBe(BODY);
    expect(toast.details).toContain("staging on this Mac: not here");
    expect(useToasts.getState().recent.some((t) => /behind/.test(t.title))).toBe(false);

    renderUi(<LocalBranchState workspaceId={WS} on="board" />);
    expect(screen.getByText(TITLE)).toBeTruthy();
    expect(screen.getByText(BODY)).toBeTruthy();
    const bring = screen.getByRole("button", { name: "Bring it up to date" });
    // 1.174.0 (A4): bordered on the Board — its one filled button is New card.
    expect(bring.className).not.toContain("cbtn--accent");
    expect(screen.getByRole("button", { name: "I don't work here" }).className).not.toContain("cbtn--accent");
    // The notice's icon is the toast's kind (item 7): info, on the calm surface.
    expect(document.querySelector(".ux-callout--info")).toBeTruthy();
    expect(document.querySelector(".ux-callout-icon--warn")).toBeNull();
  });

  it("I don't work here is kept for the workspace: the Board stops asking, Settings keeps the way back", async () => {
    await sync(lyra());
    const stub = tauri();
    stub.allowUnhandled();
    const board = renderUi(<LocalBranchState workspaceId={WS} on="board" />);
    await act(async () => {
      screen.getByRole("button", { name: "I don't work here" }).click();
    });
    await settle();
    expect(stub.callsOf("workspace_set_dont_work_here")).toEqual([
      { cmd: "workspace_set_dont_work_here", args: { id: WS, on: true } },
    ]);
    expect(useWorkspaces.getState().workspaces[0].dontWorkHere).toBe(true);
    const ack = useToasts.getState().toasts.find((t) => t.title === "Plyloft won't ask about your project folder again");
    expect(ack?.body).toBe(
      "Code and terminals opened there still say which version they show. Settings › Project › Cards' copies can turn the ask back on.",
    );
    expect(ack?.action?.label).toBe("Open Settings");
    expect(board.container.textContent).toBe("");
    board.unmount();

    // A pressed Sync doesn't ask either.
    const before = told(TITLE);
    await sync(lyra(), true);
    expect(told(TITLE)).toBe(before);

    // Settings keeps the state, and Tell me again undoes it.
    renderUi(<LocalBranchState workspaceId={WS} />);
    expect(screen.getByText(TITLE)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "I don't work here" })).toBeNull();
    const back = tauri();
    back.allowUnhandled();
    await act(async () => {
      screen.getByRole("button", { name: "Tell me again" }).click();
    });
    await settle();
    const calls = back.callsOf("workspace_set_dont_work_here");
    expect(calls[calls.length - 1]).toEqual({
      cmd: "workspace_set_dont_work_here",
      args: { id: WS, on: false },
    });
    expect(useWorkspaces.getState().workspaces[0].dontWorkHere).toBe(false);
  });

  it("Settings says I don't work here even when there is nothing to ask", () => {
    seed(true);
    renderUi(<LocalBranchState workspaceId={WS} />);
    expect(screen.getByText("You don't work in the project folder")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Tell me again" })).toBeTruthy();
  });

  it("Bring it up to date on another branch moves that branch and says cards keep using staging", async () => {
    await sync(lyra());
    const stub = tauri();
    stub.allowUnhandled();
    stub.fixture("project_folder_bring_up_to_date", {
      kind: "ownBranch",
      branch: "main",
      target: "staging",
      outcome: { kind: "fastForwarded", from: "a".repeat(40), to: "c".repeat(40), commits: 54 },
    });
    stub.fixture("kanban_github_reconcile", lyra({ newer: 641, headAt: SEP16 + 86400 * 40 }));
    const board = renderUi(<LocalBranchState workspaceId={WS} on="board" />);
    await act(async () => {
      screen.getByRole("button", { name: "Bring it up to date" }).click();
    });
    await settle();
    expect(stub.callsOf("project_folder_bring_up_to_date")).toEqual([
      { cmd: "project_folder_bring_up_to_date", args: { workspaceId: WS } },
    ]);
    const said = useToasts.getState().recent.find((t) => t.title === "main is now up to date with GitHub's main");
    expect(said?.body).toBe("Brought in 54 updates. Cards keep using GitHub's staging.");
    // Answered: the Board doesn't ask it again, and the quiet Sync after it
    // didn't toast the ask.
    expect(board.container.textContent).toBe("");
    expect(told(TITLE)).toBe(1);
  });

  it("a Bring it up to date that changed nothing leaves the ask on the Board (Reviewer 1)", async () => {
    await sync(lyra());
    const stub = tauri();
    stub.allowUnhandled();
    stub.fixture("project_folder_bring_up_to_date", {
      kind: "ownBranch",
      branch: "main",
      target: "staging",
      outcome: { kind: "diverged", ahead: 1, behind: 2 },
    });
    renderUi(<LocalBranchState workspaceId={WS} on="board" />);
    await act(async () => {
      screen.getByRole("button", { name: "Bring it up to date" }).click();
    });
    await settle();
    expect(useToasts.getState().recent.some((t) => t.title === "main here and on GitHub have both moved")).toBe(true);
    expect(screen.getByText(TITLE)).toBeTruthy();
    expect(useProjectFolder.getState().answered[WS]).toBeUndefined();
    expect(stub.callsOf("kanban_github_reconcile")).toHaveLength(1);
  });

  it("the changes sheet has a neutral title while it reads (Reviewer 4)", async () => {
    const stub = tauri();
    stub.allowUnhandled();
    stub.fixture("project_folder_changes_detail", () => new Promise(() => {}));
    useProjectFolder.setState({ sheetFor: WS });
    renderUi(<FolderChangesSheet />);
    expect(screen.getByText("Changes in your project folder")).toBeTruthy();
    expect(screen.queryByText(/^0 changes/)).toBeNull();
  });

  it("Bring it up to date with changes in the way opens the changes sheet; Ask Claude to save them types the request", async () => {
    await sync(lyra({ changedCount: 2, changedPaths: ["CONTEXT.md", ".claude/settings.json"] }));
    const stub = tauri();
    stub.allowUnhandled();
    stub.fixture("project_folder_bring_up_to_date", { kind: "changes", count: 2 });
    stub.fixture("project_folder_changes_detail", {
      totalCount: 2,
      truncated: false,
      files: [
        {
          path: "CONTEXT.md",
          kind: "modified",
          hunks: [{ header: "@@ -1 +1,2 @@", oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, body: "-old\n+new\n+more" }],
        },
        {
          path: ".claude/settings.json",
          kind: "modified",
          hunks: [{ header: "@@ -2 +2 @@", oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, body: "-a\n+b" }],
        },
      ],
    });
    renderUi(
      <>
        <LocalBranchState workspaceId={WS} on="board" />
        <FolderChangesSheet />
      </>,
    );
    await act(async () => {
      screen.getByRole("button", { name: "Bring it up to date" }).click();
    });
    await settle();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("2 changes in your project folder")).toBeTruthy();
    expect(screen.getByText("Not saved in Git yet, so GitHub's updates can't come in.")).toBeTruthy();
    expect(screen.getByText("+2 −1")).toBeTruthy();
    expect(screen.getByText("+1 −1")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Open" })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Sync again" })).toBeTruthy();
    await act(async () => {
      screen.getByRole("button", { name: "Ask Claude to save them" }).click();
    });
    const tiles = useTiles.getState().byWorkspace[WS]?.tiles ?? [];
    expect(tiles).toHaveLength(1);
    expect(tiles[0].kind).toBe("claude");
    expect(tiles[0].cwd).toBe(CWD);
    expect(tiles[0].args).toEqual([
      "Save these changes in Git with a clear commit message: CONTEXT.md, .claude/settings.json. Commit them on the branch the folder is on; don't push, and don't switch branches.",
    ]);
    // The sheet went; Plyloft itself ran nothing that writes.
    expect(useProjectFolder.getState().sheetFor).toBeNull();
    expect(stub.calls.some((c) => /commit|push|checkout|stash/.test(c.cmd))).toBe(false);
  });

  it("after I don't work here, a terminal in the project folder says its version; a card's copy doesn't", async () => {
    await sync(lyra());
    seed(true);
    const here = renderUi(<FolderVersionLine workspaceId={WS} where={CWD} />);
    expect(here.container.textContent).toContain("This is the version from 16 Sep");
    expect(screen.getByRole("button", { name: "Bring it up to date" })).toBeTruthy();
    here.unmount();
    const copy = renderUi(<FolderVersionLine workspaceId={WS} where={`${CWD}/.plyloft-worktrees/card-1/a.ts`} file />);
    expect(copy.container.textContent).toBe("");
    copy.unmount();
    const file = renderUi(<FolderVersionLine workspaceId={WS} where={`${CWD}/src/a.ts`} file />);
    expect(file.container.textContent).toContain("This is the version from 16 Sep");
  });

  it("a state of the target's own warns with the warning icon, on the calm surface", async () => {
    await sync({ ...lyra(), localBranch: { branch: "staging", outcome: { kind: "failed", reason: "fatal: x" }, folder: folder({ branch: "staging", newer: 0 }) } });
    const toast = useToasts.getState().toasts[0];
    expect(toast.kind).toBe("warn");
    expect(toast.details).toContain("fatal: x");
    expect(toast.details).toContain("Project folder: staging");
    renderUi(<LocalBranchState workspaceId={WS} on="board" />);
    expect(document.querySelector(".ux-callout--info .ux-callout-icon--warn")).toBeTruthy();
    expect(document.querySelector(".ux-callout--warn")).toBeNull();
  });
});
