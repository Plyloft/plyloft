// QoL 1.168 block 4 (session continuity):
//
//  1. An ended Claude/Codex tile offers Continue (resume the same
//     conversation, through Resume…'s check) and Start fresh; a shell keeps
//     Restart. A conversation with nothing said yet starts fresh, and says so.
//  2. After a relaunch, Terminals offers the sessions that were open when
//     Plyloft quit, in one calm line ("Dark mode was open when Plyloft quit.
//     [Reopen it] Not now"): one press resumes each in its own tile; Not now
//     puts it away (in the record too). Never automatic. F3 (1.172.1): it puts
//     itself away once a session opens or starts in that workspace.
//  3. Resume… tells two conversations of one name apart.
//  4. An empty page after closing the tiles says "No sessions open".
import { describe, expect, it, vi } from "vitest";
import { TileGrid } from "../components/TileGrid";
import { useTiles, type Tile } from "../store/tileStore";
import { useWorkspaces, type Workspace } from "../store/workspaceStore";
import { resetReopenForTests, startReopenOffers, useReopen } from "../store/reopenStore";
import { useToasts } from "../store/toastStore";
import { useKanban } from "../store/kanbanStore";
import type { KanbanCard, ShellEnvInfo, TerminalConversation, TerminalSession } from "../ipc";
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

const tiles = () => useTiles.getState().byWorkspace[ws.id]?.tiles ?? [];

function render(fixtures: Record<string, unknown> = {}) {
  act(() => useWorkspaces.setState({ workspaces: [ws], activeId: ws.id }));
  const r = renderUi(<TileGrid env={env} workspace={ws} />, { fixtures });
  // A tile's own reads (skill drift, the Codex updater) aren't these tests'.
  r.tauri.allowUnhandled();
  return r;
}

/** An ended tile as the store holds one. */
function ended(over: Partial<Tile>): Tile {
  const t = useTiles.getState().addClaudeTile(ws.id, ws.cwd);
  const tile = { ...t, ptyId: "pty-1", status: "done" as const, exitCode: 0, ...over };
  useTiles.setState((s) => ({
    byWorkspace: { ...s.byWorkspace, [ws.id]: { ...s.byWorkspace[ws.id], tiles: [tile] } },
  }));
  return tile;
}

describe("an ended Claude or Codex tile", () => {
  it("Continue resumes the same conversation, under its name", async () => {
    ended({ label: "Fix the login form", labelSource: "auto", cliSessionId: "c-7" });
    const r = render({ terminal_resume_check: { kind: "ready" } });
    const header = document.querySelector(".tile-header") as HTMLElement;
    expect(within(header).getByRole("status").textContent).toBe("Ended");
    expect(within(header).queryByRole("button", { name: "Restart" })).toBeNull();
    await r.user.click(within(header).getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(tiles()[0].status).toBe("running"));
    const t = tiles()[0];
    expect([t.kind, t.args, t.label, t.cliSessionId]).toEqual(["claude", ["--resume", "c-7"], "Fix the login form", "c-7"]);
    expect(r.tauri.callsOf("terminal_resume_check")[0].args).toEqual({ kind: "claude", cliSessionId: "c-7", cwd: ws.cwd });
  });

  it("Start fresh begins a new conversation under the default name; a member's own name stays", async () => {
    ended({ kind: "codex", label: "Cache tests", labelSource: "auto", cliSessionId: "x-1", args: ["resume", "x-1"] });
    const r = render();
    await r.user.click(screen.getByRole("button", { name: "Start fresh" }));
    const t = tiles()[0];
    expect([t.kind, t.args, t.label, t.labelSource, t.cliSessionId]).toEqual(["codex", undefined, "codex 1", undefined, undefined]);
    expect(r.tauri.callsOf("terminal_resume_check")).toHaveLength(0);

    act(() => useTiles.setState({ byWorkspace: {} }));
    ended({ label: "My work", labelSource: "user", userName: "My work", cliSessionId: "c-2" });
    act(() => useTiles.getState().restartTile(tiles()[0].id, "fresh"));
    expect([tiles()[0].label, tiles()[0].labelSource, tiles()[0].pendingCliRename]).toEqual(["My work", "user", "My work"]);
  });

  it("starts fresh, and says so, when nothing was said in it yet", async () => {
    ended({ cliSessionId: "c-empty" });
    const r = render({ terminal_resume_check: { kind: "conversationGone" } });
    await r.user.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(tiles()[0].status).toBe("running"));
    expect(tiles()[0].args).toBeUndefined();
    expect(useToasts.getState().toasts[0]?.title).toBe("Started a new conversation");
  });

  it("stays as it is when its folder is gone", async () => {
    const before = ended({ cliSessionId: "c-9" });
    const r = render({ terminal_resume_check: { kind: "folderGone" } });
    await r.user.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(useToasts.getState().toasts[0]?.title).toBe("This session can't start again here"));
    expect(tiles()[0].id).toBe(before.id);
  });

  it("a shell, and a session with no conversation yet, keep Restart", () => {
    const s = useTiles.getState().addShellTile(ws.id, ws.cwd);
    useTiles.getState().markExited(s.id, 130);
    render();
    const header = document.querySelector(".tile-header") as HTMLElement;
    expect(within(header).getByRole("status").textContent).toBe("Ended with Ctrl-C");
    expect(within(header).getByRole("button", { name: "Restart" })).toBeTruthy();
    expect(within(header).queryByRole("button", { name: "Continue" })).toBeNull();
  });
});

const OPEN_AT_QUIT: TerminalSession[] = [
  { id: "r1", kind: "claude", cwd: ws.cwd, cliSessionId: "c-1", startedAt: 1, endedAt: 9, title: "Dark mode", titleSource: "cli", openAtQuit: 9, live: false },
  { id: "r2", kind: "codex", cwd: ws.cwd, cliSessionId: "x-1", startedAt: 2, endedAt: 9, title: "Cache tests", titleSource: "user", openAtQuit: 9, live: false },
];

/** The offers as launch reads them: `since` is when this launch began. */
function offer(byWorkspace: Record<string, TerminalSession[]>, since = Date.now()) {
  act(() => useReopen.setState({ byWorkspace, since }));
}

describe("after a relaunch", () => {
  it("offers to reopen what was open at quit, and one press resumes each in its own tile", async () => {
    offer({ [ws.id]: OPEN_AT_QUIT });
    const r = render({ terminal_resume_check: { kind: "ready" }, terminal_reopen_dismiss: null });
    // Never automatic: nothing opened yet.
    expect(tiles()).toHaveLength(0);
    const region = screen.getByRole("region", { name: "Sessions open when Plyloft quit" });
    expect(region.querySelector(".tile-reopen-line")?.textContent).toBe(
      "2 sessions were open when Plyloft quit: Dark mode and Cache tests.",
    );
    const button = within(region).getByRole("button", { name: "Reopen them" });
    expect(button.getAttribute("title")).toBe("Claude: Dark mode\nCodex: Cache tests");
    await r.user.click(button);
    await waitFor(() => expect(tiles()).toHaveLength(2));
    expect(tiles().map((t) => [t.kind, t.args, t.label])).toEqual([
      ["claude", ["--resume", "c-1"], "Dark mode"],
      ["codex", ["resume", "x-1"], "Cache tests"],
    ]);
    expect(r.tauri.callsOf("terminal_reopen_dismiss").map((c) => c.args)).toEqual([{ workspaceId: ws.id }]);
    expect(screen.queryByRole("region", { name: "Sessions open when Plyloft quit" })).toBeNull();
  });

  it("is a calm line: the name in normal ink, a strong-bordered Reopen it, a quiet Not now", () => {
    offer({ [ws.id]: OPEN_AT_QUIT.slice(0, 1) });
    render();
    const region = screen.getByRole("region", { name: "Sessions open when Plyloft quit" });
    expect(region.querySelector(".tile-reopen-line")?.textContent).toBe("Dark mode was open when Plyloft quit.");
    expect(region.querySelector(".tile-reopen-name")?.textContent).toBe("Dark mode");
    const button = within(region).getByRole("button", { name: "Reopen it" });
    // 1.174.0 E7 (T6): on the empty page it is the one strong border, never a fill.
    expect(button.className).toMatch(/cbtn--strong/);
    expect(button.className).not.toMatch(/cbtn--accent/);
    expect(document.querySelectorAll(".cbtn--strong")).toHaveLength(1);
    expect(within(region).getByRole("button", { name: "Not now" }).className).toMatch(/cbtn--quiet/);
    // No "yet" sentence: a session was there. The ways to start are one quiet line.
    expect(document.body.textContent).not.toContain("No sessions here yet");
    const links = document.querySelector(".tile-grid-empty-links") as HTMLElement;
    expect(links.textContent).toMatch(/^Or start a new session:/);
    expect([...links.querySelectorAll("button")].map((b) => b.firstChild?.textContent)).toEqual([
      "Claude",
      "Codex",
      "Shell",
      "Resume…",
    ]);
    for (const b of links.querySelectorAll("button")) expect(b.className).toMatch(/cbtn--quiet/);
    // The region comes before the line.
    expect(region.compareDocumentPosition(links) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("names two and counts the rest, with the full list in its tooltip and for a screen reader", () => {
    const more: TerminalSession[] = [
      ...OPEN_AT_QUIT,
      { ...OPEN_AT_QUIT[0], id: "r3", cliSessionId: "c-3", title: "Footer" },
    ];
    offer({ [ws.id]: more });
    render();
    const line = document.querySelector(".tile-reopen-line") as HTMLElement;
    expect(line.firstChild?.textContent).toBe("3 sessions were open when Plyloft quit: ");
    expect(line.textContent).toContain("Dark mode, Cache tests and 1 more.");
    expect(line.getAttribute("title")).toBe("Claude: Dark mode\nCodex: Cache tests\nClaude: Footer");
    expect(line.querySelector(".sr-only")?.textContent).toContain("Claude: Footer");
    expect(screen.getByRole("button", { name: "Reopen them" })).toBeTruthy();
  });

  it("Not now puts the offer away, in the record too", async () => {
    offer({ [ws.id]: OPEN_AT_QUIT.slice(0, 1) });
    const r = render({ terminal_reopen_dismiss: null });
    expect(screen.getByRole("button", { name: "Reopen it" })).toBeTruthy();
    await r.user.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("button", { name: "Reopen it" })).toBeNull();
    expect(r.tauri.callsOf("terminal_reopen_dismiss")).toHaveLength(1);
    expect(r.tauri.callsOf("terminal_resume_check")).toHaveLength(0);
  });

  // 1.174.0 E7 round 1: after Not now the page doesn't greet a first use.
  it("after Not now says no sessions are open, not the first-use words", async () => {
    offer({ [ws.id]: OPEN_AT_QUIT.slice(0, 1) });
    const r = render({ terminal_reopen_dismiss: null });
    await r.user.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.getByText("No sessions open. Resume… picks up an earlier one.")).toBeTruthy();
    expect(document.body.textContent).not.toContain("No sessions here yet.");
  });

  it("keeps its row, Reopening…, until the tiles are there", async () => {
    offer({ [ws.id]: OPEN_AT_QUIT.slice(0, 1) });
    let answer: (v: unknown) => void = () => {};
    const r = render({
      terminal_reopen_dismiss: null,
      terminal_resume_check: () => new Promise((resolve) => (answer = resolve)),
    });
    await r.user.click(screen.getByRole("button", { name: "Reopen it" }));
    // The record is put away at once; the row stays while it reopens.
    expect(r.tauri.callsOf("terminal_reopen_dismiss")).toHaveLength(1);
    const region = screen.getByRole("region", { name: "Sessions open when Plyloft quit" });
    const busy = within(region).getByRole("button", { name: "Reopening…" }) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    expect(document.body.textContent).not.toContain("No sessions here yet.");
    await act(async () => answer({ kind: "ready" }));
    await waitFor(() => expect(tiles()).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Sessions open when Plyloft quit" })).toBeNull());
  });

  it("with card sessions too, says where they are above the ways to start", () => {
    act(() =>
      useKanban.setState({
        byWorkspace: {
          [ws.id]: {
            cards: [
              {
                id: "c1",
                workspaceId: ws.id,
                title: "Fix login",
                columnId: "in_progress",
                createdAt: 1,
                updatedAt: 1,
                builder: { vendor: "claude", bypass: false, ptyId: "p1", sessionLost: false, startedAt: 1, snapshots: [] },
              } as unknown as KanbanCard,
            ],
            loaded: true,
          },
        },
      } as never),
    );
    offer({ [ws.id]: OPEN_AT_QUIT.slice(0, 1) });
    render();
    const words = screen.getByText("No sessions of your own here yet. 1 card session opens on its card.");
    const links = document.querySelector(".tile-grid-empty-links") as HTMLElement;
    expect(words.compareDocumentPosition(links) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("list", { name: "Card sessions" })).toBeTruthy();
  });

  it("puts itself away, without a word, once a session opens in that workspace — not in another", async () => {
    const other = "w2";
    offer({ [ws.id]: OPEN_AT_QUIT, [other]: OPEN_AT_QUIT.slice(0, 1) });
    const r = render({ terminal_reopen_dismiss: null });
    expect(screen.getByRole("button", { name: "Reopen them" })).toBeTruthy();
    // A session in another workspace leaves this one's offer alone.
    act(() => void useTiles.getState().addShellTile(other, "/elsewhere"));
    expect(Object.keys(useReopen.getState().byWorkspace)).toEqual([ws.id]);
    expect(screen.getByRole("button", { name: "Reopen them" })).toBeTruthy();
    // A new tile here puts this one away, in the record too.
    act(() => void useTiles.getState().addShellTile(ws.id, ws.cwd));
    expect(screen.queryByRole("region", { name: "Sessions open when Plyloft quit" })).toBeNull();
    expect(useReopen.getState().byWorkspace).toEqual({});
    expect(r.tauri.callsOf("terminal_reopen_dismiss").map((c) => c.args)).toEqual([
      { workspaceId: other },
      { workspaceId: ws.id },
    ]);
    expect(useToasts.getState().toasts).toHaveLength(0);
  });

  it("a Restart, or a card's session showing as a tile here, counts as working", () => {
    // A tile from before the offer began (an ended one) doesn't.
    const old = ended({ startedAt: 1 });
    offer({ [ws.id]: OPEN_AT_QUIT });
    render({ terminal_reopen_dismiss: null });
    expect(screen.getByRole("button", { name: "Reopen them" })).toBeTruthy();
    act(() => useTiles.getState().restartTile(old.id, "fresh"));
    expect(useReopen.getState().byWorkspace[ws.id]).toBeUndefined();

    act(() => useTiles.setState({ byWorkspace: {} }));
    offer({ [ws.id]: OPEN_AT_QUIT });
    act(
      () =>
        void useTiles.getState().addAgentRunTile(
          { id: "run-1", workspaceId: ws.id, agentId: "a", agentName: "Builder", status: "running", startedAt: Date.now(), ptyId: "p" } as never,
          "Builder",
          ws.cwd,
        ),
    );
    expect(useReopen.getState().byWorkspace[ws.id]).toBeUndefined();
  });

  // 1.174.0 walk G3 Windows: the record keeps tiles nobody wrote in, but the
  // offer leaves them out (`reopen_offer_resumable`); none left, no row.
  it("with nothing that can come back, shows no row", async () => {
    resetReopenForTests();
    const r = render({ terminal_reopen_offers: {}, terminal_reopen_dismiss: null });
    act(() => startReopenOffers());
    await waitFor(() => expect(r.tauri.callsOf("terminal_reopen_offers")).toHaveLength(1));
    expect(screen.queryByRole("region", { name: "Sessions open when Plyloft quit" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Reopen/ })).toBeNull();
  });

  it("one that can't come back is said plainly, the others reopen", async () => {
    act(() => useToasts.setState({ toasts: [] } as never));
    offer({ [ws.id]: OPEN_AT_QUIT });
    const r = render({
      terminal_reopen_dismiss: null,
      terminal_resume_check: (args: { kind: string }) => (args.kind === "codex" ? { kind: "conversationGone" } : { kind: "ready" }),
    });
    await r.user.click(screen.getByRole("button", { name: "Reopen them" }));
    await waitFor(() => expect(tiles()).toHaveLength(1));
    await waitFor(() => expect(useToasts.getState().toasts.some((t) => t.title === "Reopened 1 of 2 sessions")).toBe(true));
    const toast = useToasts.getState().toasts.find((t) => t.title === "Reopened 1 of 2 sessions")!;
    expect(toast.body).toBe("Cache tests: This Codex conversation is no longer on this computer, so it can't be resumed.");
  });

  it("the offers read at launch are put away if a session opened while they were read", async () => {
    const r = render({
      terminal_reopen_offers: { [ws.id]: OPEN_AT_QUIT },
      terminal_reopen_dismiss: null,
    });
    resetReopenForTests();
    act(() => startReopenOffers());
    act(() => void useTiles.getState().addShellTile(ws.id, ws.cwd));
    await waitFor(() => expect(r.tauri.callsOf("terminal_reopen_offers")).toHaveLength(1));
    await waitFor(() => expect(r.tauri.callsOf("terminal_reopen_dismiss")).toHaveLength(1));
    expect(useReopen.getState().byWorkspace).toEqual({});
  });

  it("doesn't offer one a tile already runs, nor one whose AI isn't installed", () => {
    // A tile from before the offer began, already on c-1.
    const t = useTiles.getState().addClaudeTile(ws.id, ws.cwd, { args: ["--resume", "c-1"], cliSessionId: "c-1" });
    expect(t.cliSessionId).toBe("c-1");
    offer({ [ws.id]: OPEN_AT_QUIT }, t.startedAt + 1);
    act(() => useWorkspaces.setState({ workspaces: [ws], activeId: ws.id }));
    renderUi(<TileGrid env={{ ...env, codexPath: null }} workspace={ws} />);
    expect(screen.queryByRole("region", { name: "Sessions open when Plyloft quit" })).toBeNull();
  });
});

describe("Resume…", () => {
  it("tells two conversations of one name apart, never with more than a title's words", async () => {
    const now = Date.now();
    const rows: TerminalConversation[] = [
      { kind: "claude", cliSessionId: "c-1", title: "Walk rename", titleSource: "user", updatedAt: now - 60_000, live: false, opening: "Rename the tiles" },
      { kind: "claude", cliSessionId: "c-2", title: "Walk rename", titleSource: "user", updatedAt: now - 120_000, live: false },
      { kind: "codex", cliSessionId: "x-1", title: "Other", titleSource: "cli", updatedAt: now - 180_000, live: false, opening: "Something" },
    ];
    const r = render({ terminal_conversations: rows });
    await r.user.click(screen.getByRole("button", { name: "New" }));
    await r.user.click(screen.getByRole("menuitem", { name: /^Resume…/ }));
    const list = await screen.findByRole("listbox", { name: "Conversations" });
    const details = within(list)
      .getAllByRole("option")
      .map((o) => o.querySelector(".resume-row-detail")?.textContent ?? null);
    expect(details[0]).toMatch(/^Began “Rename the tiles” · last used \d\d:\d\d$/);
    expect(details[1]).toMatch(/^Last used \d\d:\d\d$/);
    expect(details[2]).toBeNull();
  });
});

describe("the empty page", () => {
  it("after the last tile is closed, says no sessions are open and where earlier ones are", async () => {
    const t = useTiles.getState().addShellTile(ws.id, ws.cwd);
    useTiles.getState().markExited(t.id, 0);
    render();
    await act(async () => {
      await useTiles.getState().closeTile(t.id);
    });
    expect(screen.getByText("No sessions open. Resume… picks up an earlier one.")).toBeTruthy();
  });
});
