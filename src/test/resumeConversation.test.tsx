// Terminals block P4: New › Resume… lists the project's Claude and Codex
// conversations (name · AI · when), ↑/↓ and Enter pick one, and it opens in
// a new tile that resumes it — shown instead when a tile runs it, and a
// clear sentence, no tile, when its file is gone.
import { describe, expect, it, vi } from "vitest";
import { TileGrid } from "../components/TileGrid";
import { useUi } from "../store/uiStore";
import { useTiles } from "../store/tileStore";
import { useWorkspaces, type Workspace } from "../store/workspaceStore";
import type { ShellEnvInfo, TerminalConversation } from "../ipc";
import { RESUME_EMPTY } from "../lib/terminalConversations";
import { act, renderUi, screen, waitFor, within } from "./render";

vi.mock("../components/Terminal", () => ({ Terminal: () => <div data-testid="terminal" /> }));
vi.mock("../components/CodexSession", () => ({ CodexSession: () => <div data-testid="codex" /> }));

const ws: Workspace = {
  id: "w1",
  name: "Lyra",
  cwd: "/Users/someone/code/lyra",
  createdAt: 1,
  lastOpenedAt: 1,
  openFiles: [],
  activeFile: null,
};

const env: ShellEnvInfo = {
  path: "/usr/bin",
  shell: "/bin/zsh",
  claudePath: "/usr/local/bin/claude",
  claudeVersion: "2.1.232",
  codexPath: "/usr/local/bin/codex",
  codexVersion: "0.163.0",
  codexHealthy: true,
  gitPath: "/usr/bin/git",
  gitVersion: "2.50.1",
  ghPath: null,
  ghVersion: null,
  supportsStreamJson: true,
  probeError: null,
};

const now = Date.now();
const CONVERSATIONS: TerminalConversation[] = [
  { kind: "claude", cliSessionId: "c-1", title: "Dark mode", titleSource: "cli", updatedAt: now - 5 * 60_000, live: false },
  { kind: "codex", cliSessionId: "x-1", title: "Cache tests", titleSource: "user", updatedAt: now - 3 * 86_400_000, live: false },
];

const tiles = () => useTiles.getState().byWorkspace[ws.id]?.tiles ?? [];

async function openResume(fixtures: Record<string, unknown>) {
  act(() => {
    useWorkspaces.setState({ workspaces: [ws], activeId: ws.id });
    useTiles.setState({ byWorkspace: {} });
  });
  const r = renderUi(<TileGrid env={env} workspace={ws} />, { fixtures });
  r.tauri.allowUnhandled();
  await r.user.click(screen.getByRole("button", { name: "New" }));
  await r.user.click(screen.getByRole("menuitem", { name: /^Resume…/ }));
  return r;
}

describe("New › Resume…", () => {
  it("lists each conversation by name, AI and when, and Enter resumes the one picked", async () => {
    const r = await openResume({ terminal_conversations: CONVERSATIONS, terminal_resume_check: { kind: "ready" } });
    const list = await screen.findByRole("listbox", { name: "Conversations" });
    const options = within(list).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["Dark modeClaude · last used 5m ago", "Cache testsCodex · last used 3d ago"]);
    expect(options[0].getAttribute("aria-selected")).toBe("true");
    await r.user.keyboard("{ArrowDown}");
    expect(within(list).getAllByRole("option")[1].getAttribute("aria-selected")).toBe("true");
    await r.user.keyboard("{Enter}");
    await waitFor(() => expect(tiles()).toHaveLength(1));
    const t = tiles()[0];
    expect([t.kind, t.args, t.label, t.labelSource, t.cwd]).toEqual(["codex", ["resume", "x-1"], "Cache tests", "user", ws.cwd]);
    // Challenger round 2: the member's name is theirs on the tile too (a /clear passes it on).
    expect(t.userName).toBe("Cache tests");
    expect(r.tauri.callsOf("terminal_resume_check")[0].args).toEqual({ kind: "codex", cliSessionId: "x-1", cwd: ws.cwd });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  // 1.174.0 E9 (T9): one clock, and one door to every project's sessions.
  it("says most recently used first, and ends with History › Sessions for every project", async () => {
    const r = await openResume({ terminal_conversations: CONVERSATIONS });
    const sheet = await screen.findByRole("dialog");
    await screen.findByRole("listbox", { name: "Conversations" });
    expect(sheet.textContent).toContain("from the last 28 days, most recently used first. Each opens in a new session where it ran.");
    expect(sheet.textContent).not.toContain("newest first");
    const link = within(sheet).getByRole("button", { name: "History › Sessions for every project" });
    expect(link.textContent).toBe("History › Sessions");
    expect(link.closest("p")?.textContent).toBe("Every project: History › Sessions");
    // Enter on the link is the link's, not the list's Resume.
    link.focus();
    await r.user.keyboard("{Enter}");
    expect(tiles()).toHaveLength(0);
    expect(r.tauri.callsOf("terminal_resume_check")).toHaveLength(0);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useUi.getState().historyView).toMatchObject({ tab: "sessions", workspaceId: null, text: "" });
    expect(useUi.getState().centerMode[ws.id]).toBe("activity");
  });

  it("a Claude conversation resumes with --resume, named as it was", async () => {
    const r = await openResume({ terminal_conversations: CONVERSATIONS, terminal_resume_check: { kind: "ready" } });
    await screen.findByRole("listbox", { name: "Conversations" });
    await r.user.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(tiles()).toHaveLength(1));
    expect([tiles()[0].kind, tiles()[0].args, tiles()[0].label, tiles()[0].labelSource]).toEqual([
      "claude",
      ["--resume", "c-1"],
      "Dark mode",
      "auto",
    ]);
  });

  // 1.174.0 walk G3b: a conversation from one of the project's copies is
  // listed, and resumes in that copy's folder.
  it("a copy's conversation resumes in the copy's folder", async () => {
    const copyCwd = `${ws.cwd}/.plyloft-worktrees/copy-0a0b0c0d`;
    const inCopy: TerminalConversation[] = [
      { kind: "claude", cliSessionId: "c-copy", title: "Parser try", titleSource: "cli", updatedAt: now - 60_000, live: false, cwd: copyCwd },
    ];
    const r = await openResume({ terminal_conversations: inCopy, terminal_resume_check: { kind: "ready" } });
    await screen.findByRole("listbox", { name: "Conversations" });
    await r.user.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(tiles()).toHaveLength(1));
    expect(tiles()[0].cwd).toBe(copyCwd);
    expect(r.tauri.callsOf("terminal_resume_check")[0].args).toEqual({ kind: "claude", cliSessionId: "c-copy", cwd: copyCwd });
  });

  it("a copy that is gone: Codex is offered the project folder, Claude says why not", async () => {
    const copyCwd = `${ws.cwd}/.plyloft-worktrees/copy-0a0b0c0d`;
    const gone: TerminalConversation[] = [
      { kind: "codex", cliSessionId: "x-copy", title: "Copy tests", titleSource: "cli", updatedAt: now - 60_000, live: false, cwd: copyCwd },
      { kind: "claude", cliSessionId: "c-copy", title: "Parser try", titleSource: "cli", updatedAt: now - 120_000, live: false, cwd: copyCwd },
    ];
    const r = await openResume({
      terminal_conversations: gone,
      terminal_resume_check: (args: { cwd: string }) => (args.cwd === copyCwd ? { kind: "folderGone" } : { kind: "ready" }),
    });
    await screen.findByRole("listbox", { name: "Conversations" });
    await r.user.click(screen.getByRole("button", { name: "Resume" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "The copy this conversation ran in is no longer there. Codex can pick it up in the project folder instead.",
    );
    expect(tiles()).toHaveLength(0);
    await r.user.click(screen.getByRole("button", { name: "Resume in the project folder" }));
    await waitFor(() => expect(tiles()).toHaveLength(1));
    expect([tiles()[0].kind, tiles()[0].args, tiles()[0].cwd]).toEqual(["codex", ["resume", "x-copy"], ws.cwd]);
  });

  it("a Claude conversation whose copy is gone says why it can't resume", async () => {
    const copyCwd = `${ws.cwd}/.plyloft-worktrees/copy-0a0b0c0d`;
    const r = await openResume({
      terminal_conversations: [
        { kind: "claude", cliSessionId: "c-copy", title: "Parser try", titleSource: "cli", updatedAt: now - 60_000, live: false, cwd: copyCwd },
      ],
      terminal_resume_check: { kind: "folderGone" },
    });
    await screen.findByRole("listbox", { name: "Conversations" });
    await r.user.click(screen.getByRole("button", { name: "Resume" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "The copy this conversation ran in is no longer there, and Claude resumes a conversation only in the folder it ran in.",
    );
    expect(screen.queryByRole("button", { name: "Resume in the project folder" })).toBeNull();
    expect(tiles()).toHaveLength(0);
  });

  it("a conversation whose file is gone says so and opens nothing", async () => {
    const r = await openResume({ terminal_conversations: CONVERSATIONS, terminal_resume_check: { kind: "conversationGone" } });
    await screen.findByRole("listbox", { name: "Conversations" });
    await r.user.click(screen.getByRole("button", { name: "Resume" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/no longer on this computer/);
    expect(tiles()).toHaveLength(0);
  });

  it("one a tile runs now is shown, not opened twice", async () => {
    act(() => useWorkspaces.setState({ workspaces: [ws], activeId: ws.id }));
    const live = useTiles.getState().addClaudeTile(ws.id, ws.cwd);
    act(() => useTiles.getState().setPtyId(live.id, "pty-9"));
    const r = renderUi(<TileGrid env={env} workspace={ws} />, {
      fixtures: { terminal_conversations: [{ ...CONVERSATIONS[0], live: true, livePtyId: "pty-9" }] },
    });
    r.tauri.allowUnhandled();
    await r.user.click(screen.getByRole("button", { name: "New" }));
    await r.user.click(screen.getByRole("menuitem", { name: /^Resume…/ }));
    const list = await screen.findByRole("listbox", { name: "Conversations" });
    expect(within(list).getByRole("option").textContent).toBe("Dark modeClaude · open now");
    await r.user.click(screen.getByRole("button", { name: "Open session" }));
    await waitFor(() => expect(useTiles.getState().byWorkspace[ws.id].expandedTileId).toBe(live.id));
    expect(tiles()).toHaveLength(1);
    expect(r.tauri.callsOf("terminal_resume_check")).toHaveLength(0);
    act(() => useTiles.setState({ byWorkspace: {} }));
  });

  it("with none, says so in one sentence", async () => {
    await openResume({ terminal_conversations: [] });
    expect(await screen.findByText(RESUME_EMPTY)).toBeTruthy();
  });

  it("one open in another Claude, or whose folder is gone, says so and opens nothing", async () => {
    for (const [check, words] of [
      [{ kind: "elsewhere" }, /looks open somewhere else on this Mac/],
      [{ kind: "folderGone" }, /folder it ran in is no longer there/],
    ] as const) {
      const r = await openResume({ terminal_conversations: CONVERSATIONS, terminal_resume_check: check });
      await screen.findByRole("listbox", { name: "Conversations" });
      await r.user.click(screen.getByRole("button", { name: "Resume" }));
      expect((await screen.findByRole("alert")).textContent).toMatch(words);
      expect(tiles()).toHaveLength(0);
      r.unmount();
    }
  });

  it("one a tile of another workspace runs is shown there", async () => {
    act(() => useWorkspaces.setState({ workspaces: [ws, { ...ws, id: "w2", name: "Other" }], activeId: ws.id }));
    const other = useTiles.getState().addClaudeTile("w2", ws.cwd);
    act(() => useTiles.getState().setPtyId(other.id, "pty-o"));
    const r = renderUi(<TileGrid env={env} workspace={ws} />, {
      fixtures: {
        terminal_conversations: CONVERSATIONS,
        terminal_resume_check: { kind: "inTile", workspaceId: "w2", ptyId: "pty-o" },
      },
    });
    r.tauri.allowUnhandled();
    await r.user.click(screen.getByRole("button", { name: "New" }));
    await r.user.click(screen.getByRole("menuitem", { name: /^Resume…/ }));
    await screen.findByRole("listbox", { name: "Conversations" });
    await r.user.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(useTiles.getState().byWorkspace.w2.expandedTileId).toBe(other.id));
    expect(tiles()).toHaveLength(0);
    act(() => useTiles.setState({ byWorkspace: {} }));
  });

  it("one that looks open elsewhere can still be opened, on the member's word", async () => {
    const r = await openResume({ terminal_conversations: CONVERSATIONS, terminal_resume_check: { kind: "elsewhere" } });
    await screen.findByRole("listbox", { name: "Conversations" });
    await r.user.click(screen.getByRole("button", { name: "Resume" }));
    await r.user.click(await screen.findByRole("button", { name: "Open it anyway" }));
    await waitFor(() => expect(tiles()).toHaveLength(1));
    expect(tiles()[0].args).toEqual(["--resume", "c-1"]);
  });

  // E9 round 1: Enter on Open it anyway is that button's — it opens anyway,
  // once, not the list's plain Resume again.
  it("Enter on Open it anyway opens it anyway", async () => {
    const r = await openResume({ terminal_conversations: CONVERSATIONS, terminal_resume_check: { kind: "elsewhere" } });
    await screen.findByRole("listbox", { name: "Conversations" });
    await r.user.click(screen.getByRole("button", { name: "Resume" }));
    const anyway = await screen.findByRole("button", { name: "Open it anyway" });
    anyway.focus();
    // Before round 1 the list took this Enter: a plain Resume, refused again
    // ("open elsewhere"), and no tile.
    await r.user.keyboard("{Enter}");
    await waitFor(() => expect(tiles()).toHaveLength(1));
    expect(tiles()[0].args).toEqual(["--resume", "c-1"]);
  });

  it("a conversation whose tile was just stopped and closed is not 'open now'", async () => {
    const r = await openResume({
      terminal_conversations: [{ ...CONVERSATIONS[0], live: true, livePtyId: "pty-gone" }],
      terminal_resume_check: { kind: "ready" },
    });
    const list = await screen.findByRole("listbox", { name: "Conversations" });
    expect(within(list).getByRole("option").textContent).toBe("Dark modeClaude · last used 5m ago");
    expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy();
    r.unmount();
  });
});
