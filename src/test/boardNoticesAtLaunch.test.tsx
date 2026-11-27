// 1.175.0 (round 4, T1): the launch reads every listed board, so a damaged
// one is restored (or set aside) whether or not its project is opened. Asked
// only at a board's first load in the window, the person working in project A
// was never told about project B, and B's first read from GitHub — before
// which nothing of a restored board is sent there — never started. The
// window now asks for every trouble at once, at launch
// (`board_unreadable_notices`).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { sayUnreadableBoardsAtLaunch, useKanban } from "../store/kanbanStore";
import { useToasts } from "../store/toastStore";
import { useWorkspaces } from "../store/workspaceStore";
import { FAILED_BACKOFF_MS } from "../lib/boardFreshness";
import { tauri } from "./render";

const OPEN = "ws-open";
const UNOPENED = "ws-unopened";
const KEPT = "/p/ws-unopened.json.unreadable-1";
const restored = {
  workspaceId: UNOPENED,
  projectName: "Lyra",
  restored: true,
  keptAs: KEPT,
  githubIssues: true,
};
const said = () => [...useToasts.getState().toasts, ...useToasts.getState().queue];

beforeEach(() => {
  useKanban.setState({ byWorkspace: {}, freshness: {}, syncing: {} });
  useWorkspaces.setState({
    loaded: true,
    workspaces: [
      { id: OPEN, name: "Site", cwd: "/tmp/site", kanbanSyncMode: "githubIssues" },
      { id: UNOPENED, name: "Lyra", cwd: "/tmp/lyra", kanbanSyncMode: "githubIssues" },
    ] as never,
  });
});
afterEach(() => vi.useRealTimers());

describe("boards that couldn't be read, said at launch", () => {
  it("says the board of a project that isn't opened, and starts its read from GitHub", async () => {
    tauri().fixture("board_unreadable_notices", { notices: [restored], awaitingRead: [UNOPENED] });
    tauri().fixture("kanban_github_refresh", { created: 0, patched: 0, missing: [] });
    await sayUnreadableBoardsAtLaunch();
    const toast = said()[0];
    expect(toast?.title).toBe("The board of Lyra couldn't be read");
    expect(toast?.body).toBe(
      "Plyloft opened the last saved copy. Anything changed after that copy was saved isn't in it.",
    );
    expect(toast?.details).toBe(`The file that couldn't be read is kept as ${KEPT}.`);
    // Round 6 (W3): it stays until dismissed, and the window says it was shown.
    expect(toast?.action?.label).toBe("Show in Finder");
    await waitFor(() => expect(tauri().callsOf("board_unreadable_said")).toHaveLength(1));
    expect(tauri().callsOf("board_unreadable_said")[0]?.args).toEqual({ workspaceId: UNOPENED });
    await waitFor(() => expect(tauri().callsOf("kanban_github_refresh")).toHaveLength(1));
    expect(tauri().callsOf("kanban_github_refresh")[0]?.args).toEqual({ workspaceId: UNOPENED });
    // Its board was never loaded in this window.
    expect(tauri().callsOf("kanban_load")).toHaveLength(0);
    expect(useKanban.getState().byWorkspace[UNOPENED]).toBeUndefined();
  });

  it("doesn't say the same trouble twice when that board is opened later", async () => {
    tauri().fixture("board_unreadable_notices", { notices: [restored], awaitingRead: [UNOPENED] });
    tauri().fixture("kanban_github_refresh", { created: 0, patched: 0, missing: [] });
    tauri().fixture("kanban_load", []);
    await sayUnreadableBoardsAtLaunch();
    await waitFor(() => expect(tauri().callsOf("kanban_github_refresh")).toHaveLength(1));
    // The backend hands a trouble out once: the board's own ask gets none.
    await useKanban.getState().loadFromDisk(UNOPENED);
    await waitFor(() => expect(tauri().callsOf("board_unreadable_notice")).toHaveLength(1));
    expect(said()).toHaveLength(1);
    expect(tauri().callsOf("kanban_github_refresh")).toHaveLength(1);
  });

  it("says each of several, and reads only the restored GitHub Issues ones", async () => {
    tauri().fixture("board_unreadable_notices", {
      notices: [
        restored,
        { workspaceId: "ws-local", projectName: "Notes", restored: true, keptAs: "/p/a", githubIssues: false },
        { workspaceId: OPEN, projectName: "Site", restored: false, keptAs: "/p/b", githubIssues: true },
        { workspaceId: "ws-gone", projectName: null, restored: false, keptAs: "/p/c", githubIssues: false },
      ],
      awaitingRead: [UNOPENED],
    });
    tauri().fixture("kanban_github_refresh", { created: 0, patched: 0, missing: [] });
    await sayUnreadableBoardsAtLaunch();
    // One after the other: each is shown once the one before it was
    // dismissed. W3: and only the ones that were on screen are acknowledged —
    // a quit now would bring the others back at the next launch.
    const acknowledged = () => tauri().callsOf("board_unreadable_said").map((c) => c.args.workspaceId);
    const order = [UNOPENED, "ws-local", OPEN, "ws-gone"];
    const shown: string[] = [];
    const bodies: (string | undefined)[] = [];
    for (let i = 0; i < 4; i += 1) {
      expect(said()).toHaveLength(1);
      expect(acknowledged()).toEqual(order.slice(0, i + 1));
      const toast = said()[0]!;
      shown.push(toast.title);
      bodies.push(toast.body);
      useToasts.getState().dismiss(toast.id);
      await Promise.resolve();
    }
    expect(said()).toHaveLength(0);
    expect(acknowledged()).toEqual(order);
    expect(shown).toEqual([
      "The board of Lyra couldn't be read",
      "The board of Notes couldn't be read",
      "The board of Site couldn't be read",
      "The board couldn't be read",
    ]);
    expect(bodies[2]).toBe("Plyloft started an empty board.");
    await waitFor(() => expect(tauri().callsOf("kanban_github_refresh")).toHaveLength(1));
    expect(tauri().callsOf("kanban_github_refresh")[0]?.args).toEqual({ workspaceId: UNOPENED });
  });

  it("asks again on the Board's tick, with its back-off, until the read goes through", async () => {
    vi.useFakeTimers();
    let online = false;
    tauri().fixture("board_unreadable_notices", { notices: [restored], awaitingRead: [UNOPENED] });
    tauri().fixture("kanban_github_refresh", () => {
      if (!online) throw "error connecting to api.github.com";
      return { created: 0, patched: 0, missing: [] };
    });
    await sayUnreadableBoardsAtLaunch();
    await vi.advanceTimersByTimeAsync(0);
    expect(tauri().callsOf("kanban_github_refresh")).toHaveLength(1);
    // A failed read waits the Board's back-off, not the next tick.
    await vi.advanceTimersByTimeAsync(90_000);
    expect(tauri().callsOf("kanban_github_refresh")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(FAILED_BACKOFF_MS);
    expect(tauri().callsOf("kanban_github_refresh")).toHaveLength(2);
    online = true;
    await vi.advanceTimersByTimeAsync(FAILED_BACKOFF_MS + 30_000);
    expect(tauri().callsOf("kanban_github_refresh")).toHaveLength(3);
    // It went through: nothing more is asked.
    await vi.advanceTimersByTimeAsync(3 * FAILED_BACKOFF_MS);
    expect(tauri().callsOf("kanban_github_refresh")).toHaveLength(3);
  });

  // W3: a later error covers the notice on screen; the ones waiting their
  // turn are still not shown, and the covered one comes back.
  it("keeps its turn when another toast covers the notice on screen", async () => {
    tauri().fixture("board_unreadable_notices", {
      notices: [restored, { workspaceId: OPEN, projectName: "Site", restored: false, keptAs: "/p/b", githubIssues: true }],
      awaitingRead: [],
    });
    await sayUnreadableBoardsAtLaunch();
    const first = said()[0]!;
    const later = useToasts.getState().push({ kind: "error", title: "Something else", body: "Later news." });
    expect(useToasts.getState().toasts[0]?.id).toBe(later);
    expect(tauri().callsOf("board_unreadable_said").map((c) => c.args.workspaceId)).toEqual([UNOPENED]);
    useToasts.getState().dismiss(later);
    expect(useToasts.getState().toasts[0]?.id).toBe(first.id);
    useToasts.getState().dismiss(first.id);
    await Promise.resolve();
    expect(useToasts.getState().toasts[0]?.title).toBe("The board of Site couldn't be read");
    expect(tauri().callsOf("board_unreadable_said").map((c) => c.args.workspaceId)).toEqual([UNOPENED, OPEN]);
  });

  // Round 6 (W2): the notice was shown at an earlier launch, the read never
  // went through (offline, then a quit). The marker holds the board's writes
  // again; with nothing to say, nothing started its read unless its Board
  // was opened.
  it("reads a board that was said at an earlier launch, with no second notice", async () => {
    tauri().fixture("board_unreadable_notices", { notices: [], awaitingRead: [UNOPENED] });
    tauri().fixture("kanban_github_refresh", { created: 0, patched: 0, missing: [] });
    await sayUnreadableBoardsAtLaunch();
    await waitFor(() => expect(tauri().callsOf("kanban_github_refresh")).toHaveLength(1));
    expect(tauri().callsOf("kanban_github_refresh")[0]?.args).toEqual({ workspaceId: UNOPENED });
    expect(said()).toHaveLength(0);
    expect(tauri().callsOf("kanban_load")).toHaveLength(0);
  });

  it("says nothing when every board was read, and never throws", async () => {
    await sayUnreadableBoardsAtLaunch();
    expect(said()).toHaveLength(0);
    tauri().fixture("board_unreadable_notices", () => {
      throw "no backend";
    });
    await expect(sayUnreadableBoardsAtLaunch()).resolves.toBeUndefined();
    expect(said()).toHaveLength(0);
  });
});
