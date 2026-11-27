// A session in another workspace that starts waiting for its person sends a
// system notification, through the app's own notification plugin and behind
// its own "Tell me when a session is waiting for me"
// (behavior.notifyOnSessionWaiting), not the run one. The rules of
// which session and when are lib/waitingNotify.ts's (tested under node).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWaitingNotifier } from "../store/waitingNotifier";
import { useWorkspaces, type Workspace } from "../store/workspaceStore";
import { useSettings } from "../store/settingsStore";
import { useTiles, type Tile } from "../store/tileStore";
import { act } from "./render";

const sent: { title: string; body?: string }[] = [];

class FakeNotification {
  static permission = "granted";
  constructor(title: string, options?: { body?: string }) {
    sent.push({ title, body: options?.body });
  }
}

function ws(id: string, name: string): Workspace {
  return {
    id,
    name,
    cwd: `/Users/someone/code/${name}`,
    createdAt: 1,
    lastOpenedAt: 1,
    openFiles: [],
    activeFile: null,
  };
}

/** A Claude tile in `ws` that was Ready, worked, and is back at its prompt
 *  — or, with `turn: false`, one nobody has used. */
function seedTile(ws: string, turn = true) {
  const t0 = Date.now() - 600_000;
  const tile: Tile = {
    id: `${ws}1`,
    workspaceId: ws,
    kind: "claude",
    ptyId: `pty-${ws}`,
    label: "api tests",
    cwd: "/tmp",
    startedAt: t0,
    status: "running",
    pendingClose: false,
    expanded: false,
    readiness: {
      lastOutputAt: t0 + 120_000,
      matcherIdle: true,
      leftReadyAt: turn ? t0 + 60_000 : t0,
    },
    // QoL 1.168 (Windows walk): a turn is the member's line.
    ...(turn ? { submittedAt: t0 + 60_000 } : {}),
  };
  useTiles.setState({ byWorkspace: { [ws]: { tiles: [tile], expandedTileId: null, detailTileId: null } } });
}

/** The plugin is loaded lazily; let its import and permission check settle. */
async function settle() {
  await act(async () => {
    await vi.dynamicImportSettled();
    await new Promise((r) => setTimeout(r, 0));
  });
}

function setNotify(
  on: boolean,
  which: "notifyOnSessionWaiting" | "notifyOnAgentDone" = "notifyOnSessionWaiting",
) {
  const s = useSettings.getState().settings;
  useSettings.setState({ settings: { ...s, behavior: { ...s.behavior, [which]: on } } });
}

describe("the waiting notifier", () => {
  beforeEach(() => {
    sent.length = 0;
    setNotify(true, "notifyOnSessionWaiting");
    setNotify(true, "notifyOnAgentDone");
    vi.stubGlobal("Notification", FakeNotification);
    act(() => useWorkspaces.setState({ workspaces: [ws("a", "alpha"), ws("b", "beta")], activeId: "a" }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("tells about a turn that ended in another workspace, once", async () => {
    const step = createWaitingNotifier();
    step(Date.now());
    act(() => seedTile("b"));
    step(Date.now());
    step(Date.now() + 3_000);
    await settle();
    expect(sent).toEqual([{ title: "Claude finished · see what it did", body: "beta · In “api tests”" }]);
  });

  it("says nothing for a fresh tile, for the workspace on screen, or with the setting off", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const step = createWaitingNotifier();
    step(Date.now());
    act(() => seedTile("b", false));
    step(Date.now());
    act(() => seedTile("a"));
    step(Date.now());
    act(() => setNotify(false));
    act(() => seedTile("b"));
    step(Date.now());
    await settle();
    expect(sent).toEqual([]);
  });

  it("tells about the active workspace too while Plyloft is in the background", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const step = createWaitingNotifier();
    step(Date.now());
    act(() => seedTile("a"));
    step(Date.now());
    await settle();
    expect(sent).toEqual([{ title: "Claude finished · see what it did", body: "alpha · In “api tests”" }]);
  });

  it("follows its own setting, not the run one", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    // Runs silenced, sessions still on: the waiting session is told.
    act(() => setNotify(false, "notifyOnAgentDone"));
    const step = createWaitingNotifier();
    step(Date.now());
    act(() => seedTile("b"));
    step(Date.now());
    await settle();
    expect(sent).toEqual([{ title: "Claude finished · see what it did", body: "beta · In “api tests”" }]);

    // Sessions silenced, runs back on: nothing.
    sent.length = 0;
    act(() => {
      setNotify(true, "notifyOnAgentDone");
      setNotify(false, "notifyOnSessionWaiting");
    });
    const again = createWaitingNotifier();
    again(Date.now());
    act(() => useTiles.setState({ byWorkspace: {} }));
    again(Date.now());
    act(() => seedTile("b"));
    again(Date.now());
    await settle();
    expect(sent).toEqual([]);
  });
});
