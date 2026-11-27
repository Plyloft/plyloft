// 1.173.0 A3: copies without a card in Terminals — the "In a new copy…"
// sheet (scene 2), the tile head's "Copy · name", Terminals › Copies (scene
// 3) with Make it a card, Throw away + Undo, and the pull-request sheet
// (scene 4). Mockup: ~/ply-build/next-1173/mockups/copies.html.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TileGrid } from "../components/TileGrid";
import { useTiles } from "../store/tileStore";
import { useWorkspaces, type Workspace } from "../store/workspaceStore";
import { useCopies, resetCopiesListenerForTests } from "../store/copiesStore";
import { useAccount } from "../store/accountStore";
import { useToasts } from "../store/toastStore";
import { openNewCopySheet } from "../lib/newCopySheet";
import { openWorktreeTerminal } from "../components/CardTechnicalDetails";
import { focusTile } from "../store/tileActions";
import type { CopyView, ShellEnvInfo } from "../ipc";
import { act, fireEvent, renderUi, screen, waitFor, within } from "./render";

vi.mock("../components/Terminal", () => ({ Terminal: () => <div data-testid="terminal" /> }));
vi.mock("../components/CodexSession", () => ({ CodexSession: () => <div data-testid="codex" /> }));

const ws: Workspace = {
  id: "w1",
  name: "Atelier",
  cwd: "/Users/someone/code/atelier",
  createdAt: 1,
  lastOpenedAt: 1,
  openFiles: [],
  activeFile: null,
};

const env: ShellEnvInfo = {
  path: "/usr/bin",
  shell: "/bin/zsh",
  claudePath: "/usr/local/bin/claude",
  claudeVersion: "2.1.311",
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

const COPY_PATH = `${ws.cwd}/.plyloft-worktrees/copy-1a2b3c4d`;

function row(over: Partial<CopyView> = {}): CopyView {
  return {
    id: "copy-1a2b3c4d",
    name: "inbox-empty-state",
    branch: "plyloft/copy-1a2b3c4d-inbox-empty-state",
    path: COPY_PATH,
    baseBranch: "main",
    baseCommit: "abc",
    baseSource: "origin",
    createdAt: Date.now() - 3_600_000,
    state: "active",
    changed: { count: 3, files: ["src/InboxPanel.tsx", "src/inboxView.ts", "src/inboxView.test.ts"], unreadable: false },
    terminals: 0,
    present: true,
    restorable: false,
    saved: 0,
    ...over,
  };
}

beforeEach(() => {
  resetCopiesListenerForTests();
  act(() => {
    useWorkspaces.setState({ workspaces: [ws], activeId: ws.id });
    useTiles.setState({ byWorkspace: {} } as never);
    useCopies.setState({ byWorkspace: {} });
    useAccount.setState({ gates: { teamAllowed: false } as never });
  });
});

afterEach(() => {
  act(() => {
    useCopies.setState({ byWorkspace: {} });
  });
});

function render(rows: CopyView[]) {
  const r = renderUi(<TileGrid env={env} workspace={ws} />, {
    fixtures: {
      copy_list: () => rows,
      copy_start_point: { target: "main", fromGitHub: true, readAt: Date.now() - 120_000 },
    },
  });
  r.tauri.allowUnhandled();
  return r;
}

async function openMenuItem(label: string) {
  fireEvent.click(screen.getByRole("button", { name: "New" }));
  const item = await screen.findByRole("menuitem", { name: new RegExp(label) });
  return item;
}

describe("Terminals › New › In a new copy…", () => {
  it("is the menu's last item, with its tour anchor, and opens the sheet with focus on the name", async () => {
    render([]);
    const item = await openMenuItem("In a new copy");
    expect(item.getAttribute("data-ply-tour")).toBe("terminals-new-copy");
    fireEvent.click(item);
    const dialog = await screen.findByRole("dialog", { name: "New terminal in a copy" });
    expect(dialog.textContent).toContain("without touching the project folder or the other terminals");
    expect(dialog.textContent).toContain("make it a card later");
    await waitFor(() => expect(screen.getByText("main on GitHub · read 2 min ago")).toBeTruthy());
    // No plan line: copies and cards are open on every plan.
    expect(dialog.textContent).not.toContain("Free plan");
    // Claude preselected (⌘T's kind here would be Claude); Codex isn't installed.
    expect(screen.getByRole("button", { name: "Claude" }).getAttribute("aria-pressed")).toBe("true");
    expect((screen.getByRole("button", { name: "Codex" }) as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Name" })));
  });

  it("makes the copy, opens the tile in it at once, and the head says Copy · name and Setting up…", async () => {
    const made = row({ changed: { count: 0, files: [] }, setup: { state: "running", at: 1, command: "npm ci" } });
    const r = render([]);
    r.tauri.fixture("copy_create", (args: Record<string, unknown>) => {
      expect(args).toMatchObject({ workspaceId: ws.id, name: "inbox-empty-state", open: "claude", targetBranch: null });
      return made;
    });
    fireEvent.click(await openMenuItem("In a new copy"));
    await screen.findByRole("dialog", { name: "New terminal in a copy" });
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "inbox-empty-state" } });
    await waitFor(() => expect((screen.getByRole("button", { name: "Open the copy" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Open the copy" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const tiles = useTiles.getState().byWorkspace[ws.id].tiles;
    expect(tiles).toHaveLength(1);
    expect(tiles[0].kind).toBe("claude");
    expect(tiles[0].cwd).toBe(COPY_PATH);
    expect(await screen.findByText("Copy · inbox-empty-state")).toBeTruthy();
    expect(screen.getByText("Setting up…")).toBeTruthy();
  });

  // 1.174.0 E1 (P18, 1c): asked from a Same folder chip, the copy ends with
  // the one press that clears the warning — "Close {self}".
  it("after a copy asked from Same folder, a toast offers Close for the tile that asked", async () => {
    const made = row({ changed: { count: 0, files: [] } });
    let selfId = "";
    act(() => {
      selfId = useTiles.getState().addClaudeTile(ws.id, ws.cwd).id;
    });
    const r = render([]);
    r.tauri.fixture("copy_create", () => made);
    act(() =>
      openNewCopySheet({ workspaceId: ws.id, provider: "claude", from: { tileId: selfId, self: "claude 1", peer: "claude 2" } }),
    );
    await screen.findByRole("dialog", { name: "New terminal in a copy" });
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "inbox-empty-state" } });
    await waitFor(() => expect((screen.getByRole("button", { name: "Open the copy" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Open the copy" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New terminal in a copy" })).toBeNull());
    const madeTile = useTiles.getState().byWorkspace[ws.id].tiles.find((t) => t.cwd === COPY_PATH)!;
    const toast = await waitFor(() => {
      const t = useToasts.getState().toasts.find((x) => x.title === `${madeTile.label} is in its own copy`);
      expect(t).toBeTruthy();
      return t!;
    });
    expect(toast.body).toBe("claude 1 still shares the folder with claude 2. Its conversation stays in Resume…");
    expect(toast.action?.label).toBe("Close claude 1");
    // It goes through the tile's own close (which asks only if it's working).
    act(() => toast.action?.onClick());
    await waitFor(() => {
      const still = useTiles.getState().byWorkspace[ws.id].tiles.find((t) => t.id === selfId);
      const asked = screen.queryByRole("dialog");
      expect(!still || still.pendingClose || asked !== null).toBe(true);
    });
  });

  // 1.174.0 E2 (P20, P19): before the press, what stays out and the trust
  // question; the toast keeps only what turned up while making it.
  it("says what stays out of the copy and that Claude will ask to trust its folder", async () => {
    const r = render([]);
    // This Mac's main diverged from GitHub's: the copy starts from GitHub's
    // and leaves this Mac's one step out.
    r.tauri.fixture("copy_start_point", {
      target: "main",
      fromGitHub: true,
      readAt: Date.now() - 120_000,
      projectChanged: 3,
      localAhead: 1,
      claudeTrusted: false,
    });
    r.tauri.fixture("copy_create", () =>
      row({ changed: { count: 0, files: [] }, baseSource: "origin", baseNote: "local main has diverged from origin" }),
    );
    fireEvent.click(await openMenuItem("In a new copy"));
    const dialog = await screen.findByRole("dialog", { name: "New terminal in a copy" });
    await waitFor(() =>
      expect(dialog.textContent).toContain(
        "Not in the copy3 changed files in your project folder, and 1 saved step that main on this Mac has but GitHub doesn't. They stay where they are.",
      ),
    );
    expect(dialog.textContent).toContain("Claude will ask once to trust the copy's folder: choose “Yes, I trust this folder”.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Shell" }));
    expect(dialog.textContent).not.toContain("will ask once to trust");
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Open the copy" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New terminal in a copy" })).toBeNull());
    // The sheet said it already: no toast after.
    expect(useToasts.getState().toasts.some((t) => t.title === "Copy made")).toBe(false);
  });

  // Challenger 1 (E2-1): strictly ahead of GitHub, the copy starts from this
  // Mac's branch and has its steps.
  it("this Mac's branch ahead of GitHub's: starts from main on this Mac, with no steps left out", async () => {
    const r = render([]);
    r.tauri.fixture("copy_start_point", {
      target: "main",
      fromGitHub: true,
      readAt: Date.now() - 120_000,
      projectChanged: 2,
      localAhead: 0,
      startsLocal: true,
    });
    r.tauri.fixture("copy_create", () => row({ changed: { count: 0, files: [] }, baseSource: "localAhead" }));
    fireEvent.click(await openMenuItem("In a new copy"));
    const dialog = await screen.findByRole("dialog", { name: "New terminal in a copy" });
    await waitFor(() => expect(dialog.textContent).toContain("Starts frommain on this Mac"));
    expect(dialog.textContent).toContain("Not in the copy2 changed files in your project folder aren't in it. They stay where they are.");
    expect(dialog.textContent).not.toContain("saved step");
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Open the copy" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New terminal in a copy" })).toBeNull());
    expect(useToasts.getState().toasts.some((t) => t.title === "Copy made")).toBe(false);
  });

  // The sheet read level, yet making the copy found this Mac ahead: the toast
  // says so, as before E2.
  it("ahead only when it was made: the toast says the copy started from this Mac", async () => {
    act(() => useToasts.setState({ toasts: [] } as never));
    const r = render([]);
    r.tauri.fixture("copy_start_point", { target: "main", fromGitHub: true, readAt: Date.now(), projectChanged: 0, localAhead: 0 });
    r.tauri.fixture("copy_create", () => row({ changed: { count: 0, files: [] }, baseSource: "localAhead" }));
    fireEvent.click(await openMenuItem("In a new copy"));
    await screen.findByRole("dialog", { name: "New terminal in a copy" });
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "x" } });
    await waitFor(() => expect((screen.getByRole("button", { name: "Open the copy" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Open the copy" }));
    await waitFor(() =>
      expect(useToasts.getState().toasts.find((t) => t.title === "Copy made")?.body).toBe(
        "The copy started from main on this Mac, which has changes GitHub doesn't have yet.",
      ),
    );
  });

  // Walk G3b: Claude keeps its trust on the project folder, so a copy
  // inside a trusted project isn't asked about — no promise of a question.
  it("promises no Claude trust question when Claude trusts the project folder", async () => {
    const r = render([]);
    r.tauri.fixture("copy_start_point", { target: "main", fromGitHub: true, readAt: Date.now(), claudeTrusted: true });
    fireEvent.click(await openMenuItem("In a new copy"));
    const dialog = await screen.findByRole("dialog", { name: "New terminal in a copy" });
    await waitFor(() => expect(dialog.textContent).toContain("main on GitHub"));
    expect(dialog.textContent).not.toContain("will ask once to trust");
  });

  it("says nothing of what stays out for a clean project", async () => {
    const r = render([]);
    r.tauri.fixture("copy_start_point", { target: "main", fromGitHub: true, readAt: Date.now(), projectChanged: 0, localAhead: 0 });
    fireEvent.click(await openMenuItem("In a new copy"));
    const dialog = await screen.findByRole("dialog", { name: "New terminal in a copy" });
    await waitFor(() => expect(dialog.textContent).toContain("main on GitHub"));
    expect(dialog.textContent).not.toContain("Not in the copy");
  });

  it("explains the trust question under a copy tile's header, and after a No", async () => {
    const copy = row({ changed: { count: 0, files: [] } });
    let inCopy = "";
    let inProject = "";
    act(() => {
      const t = useTiles.getState();
      inCopy = t.addClaudeTile(ws.id, COPY_PATH).id;
      inProject = t.addClaudeTile(ws.id, ws.cwd).id;
      t.setPtyId(inCopy, "pty-copy");
      t.setPtyId(inProject, "pty-project");
      t.markQuestion("pty-copy", "trust");
      t.markQuestion("pty-project", "trust");
    });
    render([copy]);
    await waitFor(() =>
      expect(screen.getByText("Claude asks this for every new copy: the folder is the copy Plyloft just made of your project. Choose “Yes, I trust this folder” in the terminal.")).toBeTruthy(),
    );
    // Only in a copy: the project folder's tile has no line.
    expect(document.querySelectorAll(".tile-copy-trust")).toHaveLength(1);
    // Answered (the question goes): no line.
    act(() => useTiles.getState().markQuestion("pty-copy", null));
    expect(document.querySelectorAll(".tile-copy-trust")).toHaveLength(0);
    // Asked again, then answered No: the session ends on the question.
    act(() => useTiles.getState().markQuestion("pty-copy", "trust"));
    act(() => useTiles.getState().markExited(inCopy, 1));
    expect(await screen.findByText("Claude needs the copy's folder trusted to work in it. Start fresh asks again.")).toBeTruthy();
    // Challenger 1 (E2-3): a scan that settles after the exit clears
    // nothing; the line stays.
    act(() => useTiles.getState().markQuestion("pty-copy", null));
    expect(screen.getByText("Claude needs the copy's folder trusted to work in it. Start fresh asks again.")).toBeTruthy();
    expect(useTiles.getState().byWorkspace[ws.id].tiles.find((t) => t.id === inCopy)?.endedOnTrust).toBe(true);
    // Start fresh: a new session, nothing carried over.
    let again: string | null = null;
    act(() => {
      again = useTiles.getState().restartTile(inCopy, "fresh");
    });
    const fresh = useTiles.getState().byWorkspace[ws.id].tiles.find((t) => t.id === again);
    expect(fresh?.endedOnTrust).toBeUndefined();
    expect(document.querySelectorAll(".tile-copy-trust")).toHaveLength(0);
  });

  // 1.174.1 P1 (T1): a Codex Builder in a card's folder gets the same kind
  // of line while Codex asks; Claude there, and Codex elsewhere, don't.
  it("explains Codex's trust question under a tile in a card's folder, only while it asks", async () => {
    const CARD_PATH = `${ws.cwd}/.plyloft-worktrees/card-mh1x-0`;
    let codexCard = "";
    act(() => {
      const t = useTiles.getState();
      codexCard = t.addCodexTile(ws.id, CARD_PATH).id;
      const claudeCard = t.addClaudeTile(ws.id, CARD_PATH).id;
      const codexProject = t.addCodexTile(ws.id, ws.cwd).id;
      t.setPtyId(codexCard, "pty-codex-card");
      t.setPtyId(claudeCard, "pty-claude-card");
      t.setPtyId(codexProject, "pty-codex-project");
      t.markQuestion("pty-codex-card", "trust");
      t.markQuestion("pty-claude-card", "trust");
      t.markQuestion("pty-codex-project", "trust");
    });
    render([]);
    expect(await screen.findByText("Codex asks to trust this repository, not only this card's folder: choose to trust it.")).toBeTruthy();
    expect(document.querySelectorAll(".tile-copy-trust")).toHaveLength(1);
    // Answered: the line goes.
    act(() => useTiles.getState().markQuestion("pty-codex-card", null));
    expect(document.querySelectorAll(".tile-copy-trust")).toHaveLength(0);
    // Ended on the question: nothing said (the line is only while it asks).
    act(() => useTiles.getState().markQuestion("pty-codex-card", "trust"));
    expect(document.querySelectorAll(".tile-copy-trust")).toHaveLength(1);
    act(() => useTiles.getState().markExited(codexCard, 1));
    expect(document.querySelectorAll(".tile-copy-trust")).toHaveLength(0);
  });

  it("A4's popover request opens this workspace's sheet only", async () => {
    render([]);
    act(() => openNewCopySheet({ workspaceId: "another", provider: "shell" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => openNewCopySheet({ workspaceId: ws.id, provider: "shell" }));
    await screen.findByRole("dialog", { name: "New terminal in a copy" });
    expect(screen.getByRole("button", { name: "Shell" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("a failed setup says so in the tile head and offers the cards' Allow and run", async () => {
    const failed = row({
      setup: { state: "failed", at: 1, command: "npm ci", approvalNeeded: true, reason: "This Mac hasn't allowed npm ci." },
    });
    const r = render([failed]);
    r.tauri.fixture("copy_setup_retry", () => ({ ...failed, setup: { state: "running", at: 2 } }));
    act(() => {
      useTiles.getState().addShellTile(ws.id, COPY_PATH);
    });
    expect(await screen.findByText("Setup needs your OK")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Allow and run" }));
    await waitFor(() => expect(r.tauri.callsOf("copy_setup_retry")).toHaveLength(1));
    expect(r.tauri.callsOf("copy_setup_retry")[0].args).toMatchObject({ copyId: failed.id, allow: "npm ci" });
  });
});

describe("Terminals › Copies", () => {
  // 1.174.0 C4 (G3a walk): a card made from a copy deleted with its folder
  // kept — Rust gives the copy back and says `copies://changed` — is in
  // Copies again, to throw away or make a card again.
  it("lists a copy again when the card made from it is deleted and its folder kept", async () => {
    const rows: CopyView[] = [];
    const r = render(rows);
    await waitFor(() => expect(r.tauri.callsOf("copy_list").length).toBeGreaterThan(0));
    await waitFor(() => expect(r.tauri.listeners("copies://changed")).toBeGreaterThan(0));
    expect(screen.queryByRole("button", { name: /^Copies/ })).toBeNull();
    rows.push(row({ saved: 1 }));
    act(() => r.tauri.emit("copies://changed", ws.id));
    fireEvent.click(await screen.findByRole("button", { name: "Copies (1)" }));
    expect(await screen.findByRole("button", { name: "More for inbox-empty-state" })).toBeTruthy();
  });

  // 1.174.0 walk G3 Windows: a commit or a save in a copy (the watcher says
  // `copies://changed`) reads the row again; a burst is one more read.
  it("reads a copy's row again when its folder changes, one read at a time", async () => {
    let current: CopyView[] = [row({ changed: { count: 0, files: [] } })];
    let release: () => void = () => {};
    let hold = false;
    const r = render([]);
    r.tauri.fixture("copy_list", () =>
      hold ? new Promise<CopyView[]>((resolve) => (release = () => resolve(current))) : current,
    );
    await waitFor(() => expect(r.tauri.listeners("copies://changed")).toBeGreaterThan(0));
    act(() => r.tauri.emit("copies://changed", ws.id));
    fireEvent.click(await screen.findByRole("button", { name: "Copies (1)" }));
    await waitFor(() => expect(document.body.textContent).toContain("nothing changed"));
    // A commit in the copy: the watcher's batches arrive while one read runs.
    current = [row({ changed: { count: 1, files: ["index.html"] } })];
    hold = true;
    const before = r.tauri.callsOf("copy_list").length;
    act(() => {
      r.tauri.emit("copies://changed", ws.id);
      r.tauri.emit("copies://changed", ws.id);
      r.tauri.emit("copies://changed", ws.id);
    });
    await waitFor(() => expect(r.tauri.callsOf("copy_list").length).toBe(before + 1));
    hold = false;
    await act(async () => release());
    await waitFor(() => expect(r.tauri.callsOf("copy_list").length).toBe(before + 2));
    await waitFor(() => expect(document.body.textContent).toContain("1 file changed: index.html"));
  });

  it("is offered only once a copy exists, and the grid stays mounted under it", async () => {
    const rows: CopyView[] = [];
    const r = render(rows);
    await waitFor(() => expect(r.tauri.callsOf("copy_list").length).toBeGreaterThan(0));
    expect(screen.queryByRole("button", { name: /^Copies/ })).toBeNull();
    rows.push(row());
    act(() => {
      useTiles.getState().addShellTile(ws.id, ws.cwd);
      useCopies.setState({ byWorkspace: { [ws.id]: [...rows] } });
    });
    const button = await screen.findByRole("button", { name: "Copies (1)" });
    fireEvent.click(button);
    expect(await screen.findByRole("heading", { name: "Copies", level: 1 })).toBeTruthy();
    // The terminal is still there, only hidden (never unmounted).
    expect(screen.getByTestId("terminal")).toBeTruthy();
    expect(document.querySelector(".tile-grid")?.classList.contains("tile-grid--behind")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Copies (1)" }));
    expect(document.querySelector(".tile-grid")?.classList.contains("tile-grid--behind")).toBe(false);
  });

  async function showCopies(rows: CopyView[]) {
    const r = render(rows);
    const button = await screen.findByRole("button", { name: `Copies (${rows.length})` });
    fireEvent.click(button);
    await screen.findByRole("heading", { name: "Copies", level: 1 });
    return r;
  }

  /** 1.174.0 E3 (tidy tables): a row's other ends are in its ⋯. */
  async function fromMore(name: string, item: string) {
    fireEvent.click(screen.getByRole("button", { name: `More for ${name}` }));
    fireEvent.click(await screen.findByRole("menuitem", { name: item }));
  }

  it("has one title, no way back inside and no section head (1.174.0 E3)", async () => {
    await showCopies([row()]);
    expect(screen.getAllByRole("heading", { name: "Copies" })).toHaveLength(1);
    expect(screen.queryByRole("heading", { name: "Terminals", level: 1 })).toBeNull();
    // No way back inside the page: the header's crumb is the one.
    const page = document.querySelector(".copies-view") as HTMLElement;
    expect(within(page).queryByRole("button", { name: /Terminals/ })).toBeNull();
    expect(page.querySelector(".ux-page-header, .ux-section-head")).toBeNull();
    expect(page.querySelector("h1, h2")).toBeNull();
    expect(screen.getByText("Work started from a terminal, each in its own copy of the project.")).toBeTruthy();
    // The header's crumb leads back; the toggle stays pressed.
    expect(screen.getByRole("button", { name: "Copies (1)" }).getAttribute("aria-pressed")).toBe("true");
    const crumb = document.querySelector(".shell-stage-header")!;
    fireEvent.click(within(crumb as HTMLElement).getByRole("button", { name: "Terminals" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Copies", level: 1 })).toBeNull());
  });

  it("is empty with words true for someone who never made one", async () => {
    const r = await showCopies([row()]);
    // The last one leaves (thrown away, its Trash days over) while Copies is open.
    r.tauri.fixture("copy_list", () => []);
    act(() => useCopies.setState({ byWorkspace: { [ws.id]: [] } }));
    const empty = await waitFor(() => {
      const e = document.querySelector(".copies-view .ux-empty");
      expect(e).toBeTruthy();
      return e!;
    });
    expect(empty.textContent).toBe("No copies yet. New › In a new copy… opens a terminal in one.");
  });

  it("each row has one button, the rest in its ⋯; a changed copy's is Make it a card", async () => {
    await showCopies([row(), row({ id: "copy-9z9z9z9z", name: "try-new-font", changed: { count: 0, files: [] }, createdAt: Date.now() - 86_400_000 })]);
    expect(screen.getByText(/3 files changed: InboxPanel.tsx, inboxView.ts, inboxView.test.ts/)).toBeTruthy();
    expect(screen.getByText("from main · 1 h ago")).toBeTruthy();
    expect(screen.getByText("from main · yesterday")).toBeTruthy();
    expect(screen.getByText(/No terminal open · nothing changed/)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Make it a card" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Open a terminal" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Open a pull request" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Throw away" })).toBeNull();
    // Every row's action is one button (one width, one right edge).
    for (const action of document.querySelectorAll(".copies-view .ux-row-cell--action")) {
      expect(action.querySelectorAll("button")).toHaveLength(1);
    }
    fireEvent.click(screen.getByRole("button", { name: "More for inbox-empty-state" }));
    expect((await screen.findAllByRole("menuitem")).map((m) => m.getAttribute("aria-labelledby") ? document.getElementById(m.getAttribute("aria-labelledby")!)?.textContent : m.textContent)).toEqual([
      "Open a pull request",
      "Open a terminal",
      "Throw away",
    ]);
    expect(screen.getByText(/gives the copy to a new card/)).toBeTruthy();
  });

  // 1.174.1 P4 (T4): the open press names the AI the copy was made with.
  it("says Open Claude for a copy made with Claude, and Open a terminal for a shell or an AI not installed", async () => {
    const clean = { changed: { count: 0, files: [] } };
    await showCopies([
      row({ ...clean, open: "claude" }),
      row({ ...clean, id: "copy-2b2b2b2b", name: "try-shell", path: `${ws.cwd}/.plyloft-worktrees/copy-2b2b2b2b`, open: "shell" }),
      // Codex isn't installed here: a plain terminal opens, and it says so.
      row({ ...clean, id: "copy-3c3c3c3c", name: "try-codex", path: `${ws.cwd}/.plyloft-worktrees/copy-3c3c3c3c`, open: "codex" }),
    ]);
    expect(screen.getAllByRole("button", { name: "Open Claude" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Open a terminal" })).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Open Codex" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open Claude" }));
    await waitFor(() =>
      expect(useTiles.getState().byWorkspace[ws.id]?.tiles.some((t) => t.kind === "claude" && t.cwd === COPY_PATH)).toBe(true),
    );
  });

  it("says Open Codex for a copy made with Codex, in its ⋯ too", async () => {
    const withCodex = { ...env, codexPath: "/usr/local/bin/codex", codexVersion: "0.50.0", codexHealthy: true };
    const r = renderUi(<TileGrid env={withCodex} workspace={ws} />, {
      fixtures: { copy_list: () => [row({ open: "codex" })], copy_start_point: { target: "main", fromGitHub: true, readAt: Date.now() } },
    });
    r.tauri.allowUnhandled();
    fireEvent.click(await screen.findByRole("button", { name: "Copies (1)" }));
    await screen.findByRole("heading", { name: "Copies", level: 1 });
    fireEvent.click(screen.getByRole("button", { name: "More for inbox-empty-state" }));
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((m) => m.textContent)).toContain("Open Codex");
  });

  it("Make it a card makes the card and says where it is", async () => {
    const r = await showCopies([row()]);
    r.tauri.fixture("copy_make_card", () => ({ card: { id: "c-1", title: "Inbox: an empty state" }, started: false }));
    fireEvent.click(screen.getByRole("button", { name: "Make it a card" }));
    await waitFor(() => expect(r.tauri.callsOf("copy_make_card")).toHaveLength(1));
    expect(r.tauri.callsOf("copy_make_card")[0].args).toMatchObject({ workspaceId: ws.id, copyId: "copy-1a2b3c4d" });
    // Walk fix (b): the words say where the Board puts it.
    await waitFor(() =>
      expect(useToasts.getState().toasts[0]?.body).toBe(
        // 1.174.0 C4: named after the copy's last commit, its brief to write.
        "“Inbox: an empty state” is in Not started, with the work from its copy. Say what the Builder should do, then Start build.",
      ),
    );
    expect(useToasts.getState().toasts[0]?.kind).toBe("info");
  });

  it("Throw away goes at once with Undo; with saved changes it asks first", async () => {
    const plain = row({ changed: { count: 0, files: [] } });
    const r = await showCopies([plain]);
    r.tauri.fixture("copy_throw_away", () => ({ ...plain, state: "trashed" }));
    r.tauri.fixture("copy_restore", () => plain);
    await fromMore("inbox-empty-state", "Throw away");
    await waitFor(() => expect(r.tauri.callsOf("copy_throw_away")).toHaveLength(1));
    await waitFor(() => expect(useToasts.getState().toasts[0]?.title).toBe("Copy thrown away"));
    act(() => useToasts.getState().toasts[0]?.action?.onClick());
    await waitFor(() => expect(r.tauri.callsOf("copy_restore")).toHaveLength(1));
  });

  it("asks before throwing away a copy whose saved changes exist nowhere else", async () => {
    const saved = row({ changed: { count: 0, files: [] }, saved: 2 });
    const r = await showCopies([saved]);
    r.tauri.fixture("copy_throw_away", () => ({ ...saved, state: "trashed" }));
    await fromMore("inbox-empty-state", "Throw away");
    const ask = await screen.findByRole("dialog", { name: "Throw this copy away?" });
    expect(ask.textContent).toContain("2 saved changes will be deleted with the copy after 7 days in the Trash.");
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Cancel"));
    expect(r.tauri.callsOf("copy_throw_away")).toHaveLength(0);
  });

  it("the pull-request sheet says nobody reviewed it, offers Make it a card, and starts on Cancel", async () => {
    const r = await showCopies([row()]);
    r.tauri.fixture("copy_open_pr", (args: Record<string, unknown>) => {
      expect(args).toMatchObject({ copyId: "copy-1a2b3c4d", title: "Inbox: say what to do" });
      return { ...row(), pr: { number: 41, url: "https://github.com/o/r/pull/41", state: "open" } };
    });
    await fromMore("inbox-empty-state", "Open a pull request");
    const sheet = await screen.findByRole("dialog", { name: "Open a pull request for inbox-empty-state" });
    expect(sheet.textContent).toContain("Plyloft saves the 3 changed files, sends this copy to GitHub and opens a pull request for main.");
    expect(sheet.textContent).toContain("Nobody has reviewed this.");
    expect(sheet.querySelector("button")?.textContent).toBe("Make it a card");
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Cancel"));
    fireEvent.change(screen.getByRole("textbox", { name: "Title" }), { target: { value: "Inbox: say what to do" } });
    fireEvent.click(screen.getByRole("button", { name: "Open the pull request" }));
    await waitFor(() => expect(r.tauri.callsOf("copy_open_pr")).toHaveLength(1));
    await waitFor(() => expect(useToasts.getState().toasts[0]?.title).toBe("Pull request opened"));
  });

  it("a copy with an open pull request shows it instead of opening another", async () => {
    await showCopies([row({ pr: { number: 41, url: "https://github.com/o/r/pull/41", state: "open" } })]);
    expect(screen.getByText(/Pull request #41 open · nobody reviewed it here/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show the pull request" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open a pull request" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More for inbox-empty-state" }));
    expect(screen.queryByRole("menuitem", { name: "Open a pull request" })).toBeNull();
  });

  // ── Challenger round 1 ──
  it("reads the pull requests again as it opens", async () => {
    const r = await showCopies([row()]);
    await waitFor(() => expect(r.tauri.callsOf("copy_refresh_prs").length).toBeGreaterThan(0));
    expect(r.tauri.callsOf("copy_refresh_prs")[0].args).toMatchObject({ workspaceId: ws.id });
  });

  it("a closed pull request offers Open a pull request again", async () => {
    await showCopies([row({ pr: { number: 41, url: "https://github.com/o/r/pull/41", state: "closed" } })]);
    fireEvent.click(screen.getByRole("button", { name: "More for inbox-empty-state" }));
    expect(await screen.findByRole("menuitem", { name: "Open a pull request" })).toBeTruthy();
    expect(screen.getByText(/3 files changed: .* · Pull request #41 closed/)).toBeTruthy();
  });

  it("holds the row's buttons while Make it a card runs, and says a refused start plainly", async () => {
    let answer: (v: unknown) => void = () => {};
    const r = await showCopies([row()]);
    r.tauri.fixture("copy_make_card", () => new Promise((resolve) => (answer = resolve)));
    fireEvent.click(screen.getByRole("button", { name: "Make it a card" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Make it a card" }) as HTMLButtonElement).disabled).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "More for inbox-empty-state" }));
    expect(((await screen.findByRole("menuitem", { name: "Open a pull request" })) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Make it a card" }));
    expect(r.tauri.callsOf("copy_make_card")).toHaveLength(1);
    await act(async () => answer({ card: { id: "c-1", title: "inbox-empty-state" }, started: false, note: "Plyloft is quitting\nmore" }));
    await waitFor(() => expect(useToasts.getState().toasts[0]?.body).toBe("“inbox-empty-state” is in Not started, with the work from its copy. Plyloft is quitting"));
    await waitFor(() => expect((screen.getByRole("button", { name: "Make it a card" }) as HTMLButtonElement).disabled).toBe(false));
  });

  // ── Walk fixes ──
  it("with a terminal open in the copy, Throw away is off and its reason is its description", async () => {
    act(() => {
      useTiles.getState().addShellTile(ws.id, COPY_PATH);
    });
    await showCopies([row({ changed: { count: 0, files: [] }, terminals: 1 })]);
    // 1.174.0 E3: in the ⋯, the reason under it and as its description.
    fireEvent.click(screen.getByRole("button", { name: "More for inbox-empty-state" }));
    const item = (await screen.findByRole("menuitem", { name: "Throw away", description: "Close its terminal first." })) as HTMLButtonElement;
    expect(item.disabled).toBe(true);
    expect(screen.getByText("Close its terminal first.")).toBeTruthy();
  });

  it("with a terminal open in a changed copy, ⋯ › Throw away is off and reads why", async () => {
    act(() => {
      useTiles.getState().addShellTile(ws.id, COPY_PATH);
    });
    await showCopies([row({ terminals: 1 })]);
    fireEvent.click(screen.getByRole("button", { name: "More for inbox-empty-state" }));
    const item = await screen.findByRole("menuitem", { name: "Throw away", description: "Close its terminal first." });
    expect((item as HTMLButtonElement).disabled).toBe(true);
  });

  it("reads the copies again as soon as a terminal in one closes", async () => {
    let tileId = "";
    act(() => {
      tileId = useTiles.getState().addShellTile(ws.id, COPY_PATH).id;
    });
    const r = await showCopies([row({ terminals: 1 })]);
    expect(screen.getByText(/A shell open/)).toBeTruthy();
    const before = r.tauri.callsOf("copy_list").length;
    act(() => {
      useTiles.getState().removeTile(tileId);
    });
    await waitFor(() => expect(r.tauri.callsOf("copy_list").length).toBeGreaterThan(before));
    expect(screen.getByText(/No terminal open/)).toBeTruthy();
  });

  it("counts only the copies to work in; one in the Trash stays reachable", async () => {
    const r = render([row({ state: "trashed", restorable: true, present: false })]);
    void r;
    const button = await screen.findByRole("button", { name: "Copies (0)" });
    fireEvent.click(button);
    expect(await screen.findByRole("button", { name: "Bring it back" })).toBeTruthy();
  });

  // ── Blocks 1+2 walk fix ──
  it("a terminal opened for a card's copy shows the grid with it, not Copies", async () => {
    await showCopies([row()]);
    expect(screen.getByRole("heading", { name: "Copies", level: 1 })).toBeTruthy();
    act(() => openWorktreeTerminal(ws.id, `${ws.cwd}/.plyloft-worktrees/card-1`));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Copies", level: 1 })).toBeNull());
    const grid = document.querySelector(".tile-grid")!;
    expect(grid.classList.contains("tile-grid--behind")).toBe(false);
    expect(useTiles.getState().byWorkspace[ws.id].tiles.some((t) => t.cwd.endsWith("card-1"))).toBe(true);
  });

  it("focusing a tile already open (Show <other>) closes Copies too", async () => {
    let id = "";
    act(() => {
      id = useTiles.getState().addShellTile(ws.id, ws.cwd).id;
    });
    await showCopies([row()]);
    act(() => focusTile(id));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Copies", level: 1 })).toBeNull());
  });
});
