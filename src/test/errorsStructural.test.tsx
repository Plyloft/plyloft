// 1.176.2 (E1): errors that say what happened — the structural fixes. A
// disabled button's reason is reachable; one helper raises the error toast;
// an unread board, a failed read and a message that didn't arrive are said,
// not drawn as empty or lost; the dictation toasts name the Dictation page.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CBtn } from "../components/ui/primitives";
import { KanbanBoard } from "../components/KanbanBoard";
import { TryCommandRow } from "../components/RepositorySettings";
import { ReleaseSheet, AUDIT_READ_FAILED } from "../components/ReleaseSheet";
import { errorToastFor, hasHomePath, pushErrorToast } from "../lib/errorToast";
import { friendlyFileError } from "../lib/errorMessages";
import { toastModelMissing, toastWhisperMissing } from "../lib/dictationController";
import { decodeHalfMadeTeam } from "../lib/teamAdmin";
import { useKanban } from "../store/kanbanStore";
import { useWorkspaces } from "../store/workspaceStore";
import { SearchPanel } from "../components/SearchPanel";
import { HistoryResults } from "../components/HistoryResults";
import { useSearch } from "../store/searchStore";
import { useInbox } from "../store/inboxStore";
import { writeBuilderInput } from "../store/builderStore";
import { useToasts } from "../store/toastStore";
import { setPlatformForTests } from "../lib/platform";
import { act, renderUi, screen, waitFor } from "./render";
import { boardWorkspace, seedBoard, BOARD_WS } from "./boardFixtures";
import { relScope, releaseFixtures } from "./releaseFixtures";
import { tauri } from "./tauri";

const lastToast = () => useToasts.getState().toasts.slice(-1)[0];

beforeEach(() => {
  setPlatformForTests("mac");
  useToasts.setState({ toasts: [], queue: [], recent: [] } as never);
});
afterEach(() => vi.useRealTimers());

describe("a disabled button's reason (item 1; opt-in `reason`)", () => {
  it("without `reason`, a title stays a plain title: no wrapper, no marker, no Tab stop", () => {
    renderUi(
      <>
        <CBtn disabled title="Reload the preview">
          Reload
        </CBtn>
        <CBtn title="Send it">Go</CBtn>
      </>,
    );
    expect(document.querySelector(".cbtn-wrap, .cbtn-reason")).toBeNull();
    expect(screen.getByRole("button", { name: "Reload" }).getAttribute("title")).toBe("Reload the preview");
    expect(screen.getByRole("button", { name: "Go" }).getAttribute("title")).toBe("Send it");
  });

  it("with `reason`, one structure enabled or disabled: the button never remounts, and the Tab stop and description come only while it is off", () => {
    const view = (disabled: boolean) => (
      <div>
        <CBtn disabled={disabled} reason="Resume the Builder session first.">
          Send
        </CBtn>
      </div>
    );
    const { rerender } = renderUi(view(true));
    const button = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
    const wrap = button.parentElement as HTMLElement;
    expect(wrap.className).toBe("cbtn-wrap");
    expect(wrap.hasAttribute("disabled")).toBe(false);
    const marker = wrap.querySelector(".cbtn-reason") as HTMLElement;
    expect(marker.tabIndex).toBe(0);
    expect(marker.getAttribute("role")).toBe("note");
    expect(marker.getAttribute("aria-label")).toBe("Resume the Builder session first.");
    expect(marker.getAttribute("data-reason")).toBe("Resume the Builder session first.");
    expect(button.getAttribute("aria-describedby")).toBe(marker.id);
    marker.focus();
    expect(document.activeElement).toBe(marker);
    // Enabled: the same elements, no Tab stop, no description.
    rerender(view(false));
    expect(screen.getByRole("button", { name: "Send" })).toBe(button);
    expect(button.parentElement).toBe(wrap);
    expect(wrap.querySelector(".cbtn-reason")).toBe(marker);
    expect(marker.tabIndex).toBe(-1);
    expect(marker.hasAttribute("data-reason")).toBe(false);
    expect(button.hasAttribute("aria-describedby")).toBe(false);
    // A null reason: the same structure, nothing to say.
    rerender(
      <div>
        <CBtn disabled reason={null}>
          Send
        </CBtn>
      </div>,
    );
    expect(screen.getByRole("button", { name: "Send" })).toBe(button);
    expect(marker.tabIndex).toBe(-1);
  });
});

describe("the one error toast (item 3)", () => {
  it("is the title, the cause in plain words, and the raw text behind Details", () => {
    pushErrorToast("Couldn't save the choice", new Error("Permission denied (os error 13)"));
    expect(lastToast()).toMatchObject({
      kind: "error",
      title: "Couldn't save the choice",
      body: "The computer didn't let Plyloft read or change a file there.",
      details: "Permission denied (os error 13)",
    });
  });

  it("a refusal already in words stands as the body, with no Details; never a cause it doesn't carry", () => {
    expect(errorToastFor("x", "This pull request is from a fork, so Plyloft can't review it here.")).toMatchObject({
      body: "This pull request is from a fork, so Plyloft can't review it here.",
    });
    expect(errorToastFor("x", "This pull request is from a fork, so Plyloft can't review it here.").details).toBeUndefined();
    expect(errorToastFor("x", "fatal: the thing broke").body).toBe("Something went wrong; Details has the tool's own words.");
    expect(errorToastFor("x", null).body).toBeUndefined();
  });

  it("then adds what was left as it was; a body of the caller's keeps the whole raw text", () => {
    expect(errorToastFor("The card wasn't archived", "gh: HTTP 401 Bad credentials", { then: "Try again." })).toMatchObject({
      body: "GitHub didn't accept the sign-in. Try again.",
      details: "gh: HTTP 401 Bad credentials",
    });
    expect(errorToastFor("x", "fatal: no", { body: "Mine." })).toMatchObject({ body: "Mine.", details: "fatal: no" });
  });

  it("converted sites use it: a terminal's program that can't be stopped, a card that didn't start", async () => {
    // tileStore.closeTile → pty_kill fails
    const { useTiles } = await import("../store/tileStore");
    tauri().fixture("pty_kill", () => Promise.reject(new Error("Permission denied (os error 13)")));
    useTiles.setState({
      byWorkspace: { w: { tiles: [{ id: "t1", kind: "shell", ptyId: "p1", status: "running", label: "x" }] } },
    } as never);
    await useTiles.getState().closeTile("t1");
    await waitFor(() => expect(lastToast()?.title).toBe("Plyloft couldn't stop the terminal's program"));
    expect(lastToast()?.body).toBe("The computer didn't let Plyloft read or change a file there.");
  });
});

describe("a board that couldn't be read (item 4a)", () => {
  it("is said, with Try again, never the first-card invitation", async () => {
    useWorkspaces.setState({ workspaces: [{ ...boardWorkspace }], activeId: BOARD_WS } as never);
    tauri().fixture("workspace_adoption_status", () => Promise.reject(new Error("not in these tests")));
    tauri().fixture("kanban_load", () => Promise.reject("This board was saved by a newer Plyloft, so it was left as it is."));
    useKanban.setState({ byWorkspace: {} });
    renderUi(<KanbanBoard workspaceId={BOARD_WS} />, { withToasts: true });
    expect(await screen.findByText("The board couldn't be read.")).toBeTruthy();
    expect(screen.queryByText(/What do you want to build/)).toBeNull();
    expect(useKanban.getState().byWorkspace[BOARD_WS]).toMatchObject({ cards: [], loaded: true, loadFailed: true });
    // Try again reads it again, and a board that reads is drawn.
    tauri().fixture("kanban_load", [
      { id: "c1", workspaceId: BOARD_WS, title: "A card", columnId: "todo", createdAt: 1, updatedAt: 1 },
    ]);
    const before = tauri().callsOf("kanban_load").length;
    await act(async () => {
      screen.getByRole("button", { name: "Try again" }).click();
    });
    await waitFor(() => expect(tauri().callsOf("kanban_load").length).toBeGreaterThan(before));
    await waitFor(() => expect(screen.queryByText("The board couldn't be read.")).toBeNull());
    expect(useKanban.getState().byWorkspace[BOARD_WS]?.loadFailed).toBeUndefined();
  });

  it("a board already on screen stays as it was when a later read fails", async () => {
    seedBoard([{ id: "c1", workspaceId: BOARD_WS, title: "Kept", columnId: "todo", createdAt: 1, updatedAt: 1 }]);
    tauri().fixture("kanban_load", () => Promise.reject(new Error("boom")));
    await useKanban.getState().loadFromDisk(BOARD_WS, true);
    expect(useKanban.getState().byWorkspace[BOARD_WS]).toMatchObject({ cards: [{ id: "c1" }], loaded: true });
    expect(useKanban.getState().byWorkspace[BOARD_WS]?.loadFailed).toBeUndefined();
  });
});

describe("silent failures that changed what is on screen (item 5)", () => {
  it("the Release sheet says when the project folder's check couldn't be read", async () => {
    useWorkspaces.setState({ workspaces: [{ id: "ws-1", name: "lyra", cwd: "/tmp/ply-test" }] as never, activeId: "ws-1" });
    useKanban.setState({ byWorkspace: { "ws-1": { cards: [], loaded: true } } } as never);
    renderUi(<ReleaseSheet ask={{ workspaceId: "ws-1", areaId: null }} onClose={() => {}} />, {
      fixtures: { ...releaseFixtures(relScope()), ship_audit: () => Promise.reject(new Error("git: not a repository")) },
    });
    expect(await screen.findByText(AUDIT_READ_FAILED)).toBeTruthy();
  });

  it("what the person typed into a Builder that didn't take it is told; the text is only offered to the clipboard, never shown or kept", async () => {
    vi.useFakeTimers();
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: (t: string) => (written.push(t), Promise.resolve()) } });
    tauri().fixture("pty_write", () => Promise.reject(new Error("pty gone")));
    writeBuilderInput("p-lost", "sk-secret-");
    writeBuilderInput("p-lost", "value\r");
    await vi.advanceTimersByTimeAsync(1500);
    const t = lastToast();
    expect(t?.title).toBe("What you typed didn't reach the Builder");
    expect(t?.body).toBe("The Builder's session isn't taking input. Resume it or start it again, then type it once more.");
    expect(t?.details).toBeUndefined();
    expect(JSON.stringify({ ...t, action: t?.action?.label })).not.toContain("sk-secret");
    expect(useToasts.getState().recent.some((r) => JSON.stringify(r).includes("sk-secret"))).toBe(false);
    expect(t?.action?.label).toBe("Copy what you typed");
    t?.action?.onClick();
    expect(written).toEqual(["sk-secret-value\n"]);
    expect(useToasts.getState().toasts.length + useToasts.getState().queue.length).toBe(1);
  });

  it("a mouse report in what was typed is not the person's text", async () => {
    vi.useFakeTimers();
    tauri().fixture("pty_write", () => Promise.reject(new Error("pty gone")));
    writeBuilderInput("p-m", "\x1b[<0;10;5Mhi");
    await vi.advanceTimersByTimeAsync(1500);
    let copied = "";
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: (t: string) => ((copied = t), Promise.resolve()) } });
    lastToast()?.action?.onClick();
    expect(copied).toBe("hi");
  });

  it("closing a tile whose program already ended says nothing", async () => {
    const { useTiles } = await import("../store/tileStore");
    tauri().fixture("pty_kill", () => Promise.reject("pty not found"));
    useTiles.setState({
      byWorkspace: { w: { tiles: [{ id: "t2", kind: "shell", ptyId: "p2", status: "running", label: "x" }] } },
    } as never);
    await useTiles.getState().closeTile("t2");
    expect(lastToast()).toBeUndefined();
  });

  it("New card on an unread board does nothing and queues nothing", async () => {
    useWorkspaces.setState({ workspaces: [{ ...boardWorkspace }], activeId: BOARD_WS } as never);
    tauri().fixture("workspace_adoption_status", () => Promise.reject(new Error("not in these tests")));
    tauri().fixture("kanban_load", () => Promise.reject("boom"));
    useKanban.setState({ byWorkspace: {} });
    renderUi(<KanbanBoard workspaceId={BOARD_WS} />, { withToasts: true });
    await waitFor(() => expect(document.querySelector("[data-ply-board-unread]")).not.toBeNull());
    window.dispatchEvent(new CustomEvent("ply:board-new-task", { detail: { workspaceId: BOARD_WS } }));
    expect(lastToast()?.title).toBe("The board couldn't be read");
    tauri().fixture("kanban_load", [{ id: "c1", workspaceId: BOARD_WS, title: "A card", columnId: "todo", createdAt: 1, updatedAt: 1 }]);
    await act(async () => {
      screen.getByRole("button", { name: "Try again" }).click();
    });
    await waitFor(() => expect(document.querySelector("[data-ply-board-unread]")).toBeNull());
    // No empty "New card" field opened by itself after the read came back.
    expect(screen.queryByPlaceholderText(/New card/i)).toBeNull();
  });

  it("How to start your app: a failed read has a Try again that can be pressed", async () => {
    let fail = true;
    const r = renderUi(<TryCommandRow workspaceId="ws-1" project="lyra" draft={{ frozen: false, repo: { pending: null, reload: async () => {} } } as never} />, {
      fixtures: {
        project_try_command_get: () => {
          if (fail) throw new Error("git: not a repository");
          return { command: null, approved: false, shared: false, readOnly: false, hasConfig: true, detection: { kind: "none" } };
        },
      },
    });
    expect(await screen.findByText("Plyloft couldn't read this repository.")).toBeTruthy();
    const again = screen.getByRole("button", { name: "Try again" }) as HTMLButtonElement;
    expect(again.disabled).toBe(false);
    expect(again.closest("fieldset[disabled]")).toBeNull();
    fail = false;
    await r.user.click(again);
    await waitFor(() => expect(screen.queryByText("Plyloft couldn't read this repository.")).toBeNull());
  });
});

describe("stale names (item 6)", () => {
  it("the dictation toasts no longer name the Doctor, and point at Dictation", () => {
    toastWhisperMissing();
    const w = lastToast()!;
    expect(w.title).toBe("Dictation needs one more program");
    // The Dictation page sends on to Diagnostics, so the button goes there.
    expect(w.action?.label).toBe("Open Diagnostics");
    expect(w.body).toBe(
      "whisper.cpp, the program that turns speech into text, isn't installed. Diagnostics installs it in one step; then hold Space again.",
    );
    expect(`${w.title} ${w.body}`).not.toMatch(/Doctor/);
    toastModelMissing("base");
    expect(lastToast()!.body).not.toMatch(/Doctor/);
  });

  it("on Windows, whisper isn't offered an install or a Diagnostics install", () => {
    setPlatformForTests("windows");
    toastWhisperMissing();
    const w = lastToast()!;
    expect(w.body).toBe("Dictation in Codex and shell tiles isn't available on Windows yet: Plyloft can't install the program it needs there.");
    expect(w.body).not.toMatch(/Diagnostics|Doctor/);
  });
});

describe("other pieces", () => {
  it("an unreadable file's toast keeps the OS's text under Details", () => {
    const f = friendlyFileError("stat: No such file or directory (os error 2)");
    expect(f.title).toBe("File not found");
    expect(f.body).toBe("A file or folder it needed isn't there any more.");
    expect(f.details).toBe("stat: No such file or directory (os error 2)");
  });

  it("a half-made team is told by its repository", () => {
    const raw =
      "create /Users/x/y: Permission denied (os error 13) — acme/team-x exists on GitHub but is not finished (the clone). Press Create team again with the same name to complete it.";
    expect(decodeHalfMadeTeam(new Error(raw))).toEqual({
      repo: "acme/team-x",
      body: "acme/team-x exists on GitHub but isn't finished. Press Create team again with the same name to complete it.",
    });
    expect(decodeHalfMadeTeam("gh: HTTP 401")).toBeNull();
  });
});

describe("the review's fixes", () => {
  it("a missing Claude is the tile's sentence, with no raw line and no home path in the body", () => {
    const gone =
      'PLY_CLI_UNAVAILABLE_V1:{"tool":"claude","was":"/Users/alice/.local/bin/claude"}\nclaude: not found in PATH. Plyloft looked for it again; it was at /Users/alice/.local/bin/claude.';
    const t = errorToastFor("The card didn't start", gone);
    expect(t.body).toBe("Claude Code didn't start: Plyloft can't find it on this Mac any more.");
    expect(t.body).not.toContain("/Users/");
    expect(t.details).toBe(gone);
  });

  it("a body in the app's words never holds a path under the home folder: that text goes under Details", () => {
    expect(hasHomePath("The folder /Users/alice/code/x is gone.")).toBe(true);
    expect(hasHomePath("C:\\Users\\alice\\code is gone.")).toBe(true);
    expect(hasHomePath("Nothing in /tmp/x.")).toBe(false);
    const t = errorToastFor("Couldn't open it", "The folder /Users/alice/code/x is gone and Plyloft can't read it.");
    expect(t.body).toBe("Something went wrong; Details has the tool's own words.");
    expect(t.details).toContain("/Users/alice/");
    // The backend's `my_library` sentence, a backticked name first, stands.
    const lib = errorToastFor("Couldn't add it", "`my-skills` already exists and isn't a skills library. Pick another name.");
    expect(lib.body).toBe("“my-skills” already exists and isn't a skills library. Pick another name.");
    expect(lib.details).toBeUndefined();
  });

  it("⌘K History: a failed sessions read joins the line with one full stop", async () => {
    renderUi(<HistoryResults query="a" onClose={() => {}} />, {
      fixtures: { terminal_sessions_history_all: () => Promise.reject(new Error("boom")), history_search_cancel: null },
    });
    expect(
      await screen.findByText("Type at least two characters. Plyloft couldn't read your Terminals sessions, so they weren't searched."),
    ).toBeTruthy();
  });

  it("the Search panel shows the backend's full sentence alone, and a raw failure with its cause", async () => {
    const said = "That isn't a valid regular expression (unclosed group). Turn off “Regular expression” to search for the text exactly as typed.";
    useSearch.setState({
      byWorkspace: { w1: { query: "abc", options: { caseSensitive: false, wholeWord: false, regex: true, includeHidden: false, glob: "" }, results: [], status: "idle" } },
    } as never);
    renderUi(<SearchPanel workspaceId="w1" cwd="/tmp/x" onOpenMatch={() => {}} query="abc" />, {
      fixtures: { search_start: () => Promise.reject(said), ripgrep_available: true, search_cancel: null },
    });
    expect(await screen.findByText(said)).toBeTruthy();
    expect(screen.queryByText(/The search failed/)).toBeNull();
  });

  it("the Inbox reads again, quietly, when the feed changed under it, and keeps a clue otherwise", async () => {
    let calls = 0;
    tauri().fixture("inbox_feed", () => {
      calls += 1;
      if (calls === 1) return Promise.reject("Inbox user changed; refresh required");
      return Promise.resolve({ events: [], generatedAt: 1 });
    });
    await useInbox.getState().refresh();
    expect(calls).toBe(2);
    expect(useInbox.getState().error).toBeNull();
    tauri().fixture("inbox_feed", () => Promise.reject("fatal: the thing broke"));
    await useInbox.getState().refresh();
    // 1.176.3: an unrecognised cause is not printed raw (Windows walk).
    expect(useInbox.getState().error).toBe("The Inbox couldn't be read.");
    expect(useInbox.getState().error).not.toContain("Details");
  });

  it("the half-made team's title is Your team isn't finished", () => {
    expect(decodeHalfMadeTeam("x — a/b exists on GitHub but is not finished (the clone). Press Create team again with the same name to complete it.")?.repo).toBe("a/b");
  });
});
