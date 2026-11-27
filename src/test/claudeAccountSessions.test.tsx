// 1.179.0 (C2): with a second Claude account, a session names the account it
// runs on — the tile header, New's "Claude on {name}", History's rows, the
// Inbox's usage limit — and with Main alone nothing of it shows. (The card's
// Run step is in cardPage.test.tsx.)
import { describe, expect, it, vi } from "vitest";
import { TileGrid } from "../components/TileGrid";
import { HistorySessions } from "../components/HistorySessions";
import { useTiles } from "../store/tileStore";
import { useWorkspaces, type Workspace } from "../store/workspaceStore";
import { sessionBlocksFrom } from "../lib/sessionBlock";
import { waitingSessions, waitingWords } from "../lib/needsYou";
import type { ShellEnvInfo, TerminalHistorySession } from "../ipc";
import { act, renderUi, screen, waitFor, within } from "./render";

// The terminal body is xterm and a PTY: only what the tile hands it matters.
const seen = vi.hoisted(() => ({ props: [] as Array<{ cli?: string; account?: string }> }));
vi.mock("../components/Terminal", () => ({
  Terminal: (p: { cli?: string; account?: string }) => {
    seen.props.push({ cli: p.cli, account: p.account });
    return <div data-testid="terminal" />;
  },
}));
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
  codexPath: null,
  codexVersion: null,
  codexHealthy: false,
  gitPath: "/usr/bin/git",
  gitVersion: "2.50.1",
  ghPath: null,
  ghVersion: null,
  supportsStreamJson: true,
  probeError: null,
};

const MAIN = { id: null, name: "Main", signedIn: "yes", isCurrent: true, folder: null };
const WORK = { id: "acct0001", name: "Work", signedIn: "yes", isCurrent: false, folder: "/Users/someone/work" };
const TWO = { ai_accounts_list: [MAIN, WORK] };

const tiles = () => useTiles.getState().byWorkspace[ws.id]?.tiles ?? [];

function grid(fixtures: Record<string, unknown> = {}) {
  act(() => useWorkspaces.setState({ workspaces: [ws], activeId: ws.id }));
  const r = renderUi(<TileGrid env={env} workspace={ws} />, { fixtures: { terminal_conversations: [], ...fixtures } });
  r.tauri.allowUnhandled();
  return r;
}

describe("a Claude tile's header", () => {
  it("names its account after Claude, with the tooltip, when there are two", async () => {
    act(() => void useTiles.getState().addClaudeTile(ws.id, ws.cwd, { account: "acct0001" }));
    grid(TWO);
    const chip = await waitFor(() => {
      const el = document.querySelector<HTMLElement>("[data-ply-tile-account]");
      expect(el).toBeTruthy();
      return el!;
    });
    expect(chip.textContent).toBe("Claude · Work");
    expect(chip.getAttribute("title")).toBe(
      "This session runs on your Claude account Work. Its conversation is kept in that account's folder.",
    );
    // A tile on Main, once its title says so, names Main.
    act(() => {
      const t = useTiles.getState().addClaudeTile(ws.id, ws.cwd);
      useTiles.getState().setTileAccount(t.id, null);
    });
    await waitFor(() =>
      expect([...document.querySelectorAll("[data-ply-tile-account]")].map((e) => e.textContent)).toEqual([
        "Claude · Work",
        "Claude · Main",
      ]),
    );
  });

  it("names nothing with Main alone", async () => {
    act(() => {
      const t = useTiles.getState().addClaudeTile(ws.id, ws.cwd);
      useTiles.getState().setTileAccount(t.id, null);
    });
    const r = grid();
    await waitFor(() => expect(r.tauri.callsOf("ai_accounts_list").length).toBeGreaterThan(0));
    expect(document.querySelector("[data-ply-tile-account]")).toBeNull();
    expect(document.body.textContent).not.toContain("Claude · Main");
  });
});

describe("New › Claude on {name}", () => {
  it("offers one entry per account and spawns the tile on the one picked", async () => {
    seen.props = [];
    const r = grid(TWO);
    await waitFor(() => expect(r.tauri.callsOf("ai_accounts_list").length).toBeGreaterThan(0));
    await r.user.click(screen.getByRole("button", { name: "New" }));
    const menu = screen.getByRole("menu", { name: "New session" });
    await waitFor(() => expect(within(menu).getByRole("menuitem", { name: /^Claude on Work/ })).toBeTruthy());
    expect(within(menu).getByRole("menuitem", { name: /^Claude on Main/ })).toBeTruthy();
    await r.user.click(within(menu).getByRole("menuitem", { name: /^Claude on Work/ }));
    await waitFor(() => expect(tiles()).toHaveLength(1));
    expect([tiles()[0].kind, tiles()[0].account]).toEqual(["claude", "acct0001"]);
    // What its spawn asks for (`pty_spawn`'s `account`).
    await waitFor(() => expect(seen.props).toContainEqual({ cli: "claude", account: "acct0001" }));
  });

  it("the plain Claude entry asks for no account (the one for new sessions)", async () => {
    seen.props = [];
    const r = grid(TWO);
    await r.user.click(screen.getByRole("button", { name: "New" }));
    const plain = screen
      .getAllByRole("menuitem")
      .find((b) => b.textContent?.startsWith("Claude") && !b.textContent.includes("Claude on"));
    await r.user.click(plain!);
    await waitFor(() => expect(tiles()).toHaveLength(1));
    expect(tiles()[0].account).toBeUndefined();
    await waitFor(() => expect(seen.props).toContainEqual({ cli: "claude", account: undefined }));
  });

  it("has no account entries with Main alone", async () => {
    const r = grid();
    await waitFor(() => expect(r.tauri.callsOf("ai_accounts_list").length).toBeGreaterThan(0));
    await r.user.click(screen.getByRole("button", { name: "New" }));
    const menu = screen.getByRole("menu", { name: "New session" });
    expect(within(menu).queryByRole("menuitem", { name: /Claude on/ })).toBeNull();
  });
});

describe("History › Sessions rows", () => {
  const row = (over: Partial<TerminalHistorySession>): TerminalHistorySession => ({
    id: "s-1",
    kind: "claude",
    cwd: ws.cwd,
    cliSessionId: "00000000-0000-4000-8000-000000000001",
    startedAt: Date.now() - 3_600_000,
    endedAt: Date.now() - 3_000_000,
    title: "Parser fix",
    titleSource: "cli",
    live: false,
    workspaceId: ws.id,
    resumable: true,
    ...over,
  });

  it("a row whose account was removed says so and offers no Resume; another names its account", async () => {
    act(() => useWorkspaces.setState({ workspaces: [ws], activeId: ws.id }));
    const r = renderUi(<HistorySessions env={env} reloadKey={0} />, {
      fixtures: {
        ...TWO,
        terminal_sessions_history_all: {
          sessions: [
            row({ id: "s-gone", title: "Old work", account: "acct0009", resumable: false, gone: "account" }),
            row({
              id: "s-work",
              cliSessionId: "00000000-0000-4000-8000-000000000002",
              title: "On work",
              account: "acct0001",
              endedAt: Date.now() - 60_000,
            }),
          ],
          unreadable: [],
        },
      },
    });
    r.tauri.allowUnhandled();
    const gone = await screen.findByRole("button", { name: "Resume Old work" });
    expect((gone as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText("Its account was removed from Plyloft.").length).toBeGreaterThan(0);
    const work = screen.getByRole("button", { name: "Resume On work" });
    expect((work as HTMLButtonElement).disabled).toBe(false);
    await waitFor(() => expect(work.getAttribute("title")).toBe("Resumes on Work, where this conversation is kept."));
    expect(screen.getByText("Claude · Work")).toBeTruthy();
  });
});

describe("the Inbox's usage limit row", () => {
  const blocks = sessionBlocksFrom([
    { key: "c1", workspaceId: ws.id, vendor: "claude", kind: "usageLimit", resetsAt: "6pm", account: "acct0001" },
  ]);
  const waiting = waitingSessions({
    tilesByWorkspace: {},
    builders: {},
    cardTitle: () => "Parser fix",
    now: Date.now(),
    sessionBlocks: blocks,
  });

  it("keeps the block's account", () => {
    expect(blocks.c1.account).toBe("acct0001");
    expect(waiting[0].account).toBe("acct0001");
  });

  it("says Claude (Work) usage limit · resets 6pm when accounts are named, as before otherwise", () => {
    expect(waitingWords(waiting[0], "Work").title).toBe("Claude (Work) usage limit · resets 6pm");
    expect(waitingWords(waiting[0]).title).toBe("Claude · Paused · your plan's limit resets at 6pm");
  });
});
