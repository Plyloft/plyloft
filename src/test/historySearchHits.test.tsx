// QoL 11.3: a ⌘⇧H hit opens what it points at — the card itself (not the
// Board), a run's output, a brainstorm's card or mailbox — and the
// Terminals sessions are found by their stored title (never what was said).
import { describe, expect, it } from "vitest";
import { CommandPalette } from "../components/CommandPalette";
import { useWorkspaces, type Workspace } from "../store/workspaceStore";
import { useKanban } from "../store/kanbanStore";
import { useUi } from "../store/uiStore";
import type { HistoryHit, KanbanCard, TerminalHistorySession } from "../ipc";
import { act, nextFrame, renderUi, screen, tauri, waitFor, within } from "./render";
import { cardHitExcerpt, cutJsonString } from "../lib/historyDeepLink";

const NOW = Date.now();
const ws = (id: string, name: string): Workspace => ({
  id,
  name,
  cwd: `/code/${id}`,
  createdAt: 1,
  lastOpenedAt: 1,
  openFiles: [],
  activeFile: null,
});

const card = (id: string, over: Partial<KanbanCard> = {}): KanbanCard =>
  ({ id, workspaceId: "l", title: id, columnId: "todo", ...over }) as KanbanCard;

const SESSIONS: TerminalHistorySession[] = [
  {
    id: "1",
    workspaceId: "l",
    kind: "claude",
    cwd: "/code/l",
    startedAt: NOW - 60_000,
    endedAt: NOW - 30_000,
    live: false,
    resumable: true,
    cliSessionId: "c-1",
    title: "Dark mode toggle",
  },
  {
    id: "2",
    workspaceId: "v",
    kind: "codex",
    cwd: "/code/v",
    startedAt: NOW - 60_000,
    endedAt: NOW - 30_000,
    live: false,
    resumable: true,
    cliSessionId: "c-2",
    title: "Dark corners",
  },
] as TerminalHistorySession[];

async function renderPalette() {
  tauri().allowUnhandled();
  tauri().fixture("history_search_start", null);
  tauri().fixture("history_search_cancel", null);
  tauri().fixture("terminal_sessions_history_all", { sessions: SESSIONS, unreadable: [] });
  tauri().fixture("agent_run_get", { id: "run-9", workspaceId: "v", agentName: "Nightly" });
  act(() => {
    useWorkspaces.setState({ workspaces: [ws("l", "Lyra"), ws("v", "Vega")], activeId: "l" });
    useKanban.setState({
      byWorkspace: {
        l: {
          cards: [card("c-login"), card("c-brain", { linkedBrainstormId: "sw-1" })],
          loaded: true,
        },
      },
    } as never);
  });
  const r = renderUi(<CommandPalette activeWorkspaceId="l" claudeAvailable onOpenInstalledSelfCheck={() => {}} />);
  act(() => useUi.getState().openPalette("history"));
  await nextFrame();
  return r;
}

const dialog = () => screen.getByRole("dialog", { name: "Search" });

async function hit(r: Awaited<ReturnType<typeof renderPalette>>, h: Partial<HistoryHit> & Pick<HistoryHit, "kind">, label: string) {
  await r.user.type(within(dialog()).getByRole("textbox", { name: "Search" }), "zz");
  await waitFor(() => expect(tauri().callsOf("history_search_start").length).toBeGreaterThan(0));
  act(() => {
    tauri().emit("history://result", {
      workspaceId: "l",
      artifactId: "l",
      path: "/x",
      lineNumber: 3,
      lineText: label,
      matchText: "zz",
      ...h,
    });
    tauri().emit("history://done", { status: "completed", message: null, total: 1 });
  });
  await r.user.click(await within(dialog()).findByRole("button", { name: new RegExp(label) }));
}

describe("⌘⇧H hits", () => {
  it("a card hit opens that card, not just the Board", async () => {
    const r = await renderPalette();
    await hit(r, { kind: "card", cardId: "c-login" }, "Fix the login");
    await waitFor(() => expect(useUi.getState().selectedCardId.l).toBe("c-login"));
    expect(useUi.getState().centerMode.l).toBe("board");
  });

  it("a card hit whose card can't be told lands on the Board", async () => {
    const r = await renderPalette();
    await hit(r, { kind: "card", cardId: null }, "Some line");
    await waitFor(() => expect(useUi.getState().centerMode.l).toBe("board"));
    expect(useUi.getState().selectedCardId.l ?? null).toBeNull();
  });

  it("a run transcript opens the run's output, in the run's own workspace", async () => {
    const r = await renderPalette();
    await hit(r, { kind: "runTranscript", workspaceId: null, artifactId: "run-9" }, "the run said");
    await waitFor(() =>
      expect(useUi.getState().historySheet).toEqual({ kind: "run", workspaceId: "v", runId: "run-9" }),
    );
  });

  it("saved work opens the run with its changes", async () => {
    const r = await renderPalette();
    await hit(r, { kind: "snapshot", workspaceId: null, artifactId: "run-9" }, "src/app.ts");
    await waitFor(() =>
      expect(useUi.getState().historySheet).toEqual({ kind: "run", workspaceId: "v", runId: "run-9" }),
    );
  });

  it("a brainstorm opens its card, else its mailbox", async () => {
    const r = await renderPalette();
    await hit(r, { kind: "swarmMailbox", artifactId: "sw-1" }, "an idea");
    await waitFor(() => expect(useUi.getState().selectedCardId.l).toBe("c-brain"));
  });

  it("a brainstorm with no card opens its mailbox", async () => {
    const r = await renderPalette();
    await hit(r, { kind: "swarmMailbox", artifactId: "sw-2" }, "another idea");
    await waitFor(() =>
      expect(useUi.getState().historySheet).toEqual({ kind: "brainstorm", workspaceId: "l", swarmId: "sw-2" }),
    );
  });
});

describe("⌘⇧H card hits read as words", () => {
  it("show the card's title and a plain excerpt of what matched, never the board's JSON", async () => {
    const r = await renderPalette();
    await r.user.type(within(dialog()).getByRole("textbox", { name: "Search" }), "index");
    await waitFor(() => expect(tauri().callsOf("history_search_start").length).toBeGreaterThan(0));
    act(() => {
      tauri().emit("history://result", {
        kind: "card",
        workspaceId: "l",
        artifactId: "l",
        cardId: "c-login",
        cardTitle: "Make the greeting bold",
        path: "/x",
        lineNumber: 9,
        lineText: '      "notes": "In index.html, make the \\"Hello\\" heading bold.",',
        matchText: "index",
      });
      tauri().emit("history://result", {
        kind: "card",
        workspaceId: "l",
        artifactId: "l",
        cardId: "c-brain",
        path: "/x",
        lineNumber: 30,
        lineText: '      "title": "c-brain",',
        matchText: "c-b",
      });
      tauri().emit("history://done", { status: "completed", message: null, total: 2 });
    });
    const first = await within(dialog()).findByRole("button", { name: /Make the greeting bold/ });
    expect(first.textContent).toContain('in its brief: “In index.html, make the "Hello" heading bold.”');
    // A hit from an older backend: the title from the loaded board.
    const second = await within(dialog()).findByRole("button", { name: /^c-brain/ });
    expect(second.textContent).toContain("in its title");
    expect(dialog().textContent).not.toMatch(/"notes":|"title":/);
  });
});

describe("⌘⇧H snippets read as words (1.168.1 A3)", () => {
  it("a card line the search cut short reads its escapes, never a literal \\n", async () => {
    const r = await renderPalette();
    await r.user.type(within(dialog()).getByRole("textbox", { name: "Search" }), "APPROVE");
    await waitFor(() => expect(tauri().callsOf("history_search_start").length).toBeGreaterThan(0));
    act(() => {
      tauri().emit("history://result", {
        kind: "card",
        workspaceId: "l",
        artifactId: "l",
        cardId: "c-login",
        cardTitle: "Add a dark mode toggle",
        path: "/x",
        lineNumber: 40,
        // history_search.rs cuts a line at 500 characters: no closing quote.
        lineText: '            "body": "## Verdict\\nAPPROVE\\n\\n## Why\\nThe \\"toggle\\" works…',
        matchText: "APPROVE",
      });
      tauri().emit("history://done", { status: "completed", message: null, total: 1 });
    });
    const row = await within(dialog()).findByRole("button", { name: /Add a dark mode toggle/ });
    expect(row.textContent).toContain('in the card: “## Verdict APPROVE ## Why The "toggle" works”');
    expect(row.textContent).not.toContain("\\n");
  });

  it("a transcript line's carriage returns read as spaces", async () => {
    const r = await renderPalette();
    await r.user.type(within(dialog()).getByRole("textbox", { name: "Search" }), "dark");
    await waitFor(() => expect(tauri().callsOf("history_search_start").length).toBeGreaterThan(0));
    act(() => {
      tauri().emit("history://result", {
        kind: "intakeTranscript",
        workspaceId: "l",
        artifactId: "i-1",
        path: "/x",
        lineNumber: 10,
        lineText: "\rCard title: Add a dark mode toggle\r\rNotes:\r\r",
        matchText: "dark",
      });
      tauri().emit("history://done", { status: "completed", message: null, total: 1 });
    });
    const row = await within(dialog()).findByRole("button", { name: /Card title/ });
    expect(row.textContent).toContain("Card title: Add a dark mode toggle Notes:");
  });
});

describe("a cut JSON string (1.168.1 A3)", () => {
  it("reads its escapes and drops the one the cut split", () => {
    expect(cutJsonString('"a\\nb\\u00e9…')).toBe("a\nbé");
    expect(cutJsonString('"say \\u00…')).toBe("say ");
    expect(cutJsonString('"say \\…')).toBe("say ");
    // An escaped backslash before the cut stays one backslash.
    expect(cutJsonString('"C:\\\\…')).toBe("C:\\");
    // Cut just after its own closing quote and comma.
    expect(cutJsonString('"done",…')).toBe("done");
    // An escaped quote at the cut is the text's, not the closing one.
    expect(cutJsonString('"say \\"…')).toBe('say "');
    expect(cutJsonString("plain")).toBe("plain");
  });

  it("gives a card line cut after its closing quote its words", () => {
    expect(cardHitExcerpt('      "notes": "Add a toggle",…', "toggle")).toEqual({ where: "in its brief", text: "Add a toggle" });
  });
});

describe("⌘⇧H finds Terminals sessions by their title", () => {
  it("lists the matching sessions of this workspace, or every one, and opens History › Sessions on one", async () => {
    const r = await renderPalette();
    await r.user.type(within(dialog()).getByRole("textbox", { name: "Search" }), "dark");
    const here = await within(dialog()).findByRole("button", { name: /Dark mode toggle/ });
    expect(within(dialog()).queryByRole("button", { name: /Dark corners/ })).toBeNull();
    expect([...dialog().querySelectorAll(".palette-section")].map((c) => c.textContent)).toContain(
      "Terminals sessions",
    );

    await r.user.click(within(within(dialog()).getByRole("group", { name: "Where" })).getByRole("button", { name: "All workspaces" }));
    expect(await within(dialog()).findByRole("button", { name: /Dark corners/ })).toBeTruthy();

    await r.user.click(within(dialog()).getByRole("button", { name: /Dark mode toggle/ }));
    await waitFor(() => expect(useUi.getState().centerMode.l).toBe("activity"));
    expect(useUi.getState().historyView).toEqual({ tab: "sessions", workspaceId: "l", text: "Dark mode toggle", fromSearch: true });
    expect(here).toBeTruthy();
  });

  it("never matches on anything but the title", async () => {
    const r = await renderPalette();
    await r.user.type(within(dialog()).getByRole("textbox", { name: "Search" }), "c-1");
    await waitFor(() => expect(tauri().callsOf("history_search_start").length).toBeGreaterThan(0));
    act(() => tauri().emit("history://done", { status: "completed", message: null, total: 0 }));
    expect(await within(dialog()).findByText("No matches.")).toBeTruthy();
  });
});
