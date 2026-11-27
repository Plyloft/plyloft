// QoL 1.168 G1 (Challenger round 1): "Install when my work is done" waits
// for a shell running a command (unknown counts as running), an unsent draft
// and an open surface; two idle looks install. A Mac quit installs the
// scheduled update before it answers the quit — never on Windows, and the
// ack is held only when there is something to install.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuitGuardSheet } from "../components/QuitGuardSheet";
import { lookForIdle, setUpdateFlowForTests } from "../components/UpdatePrompt";
import { UpdateFlow, type UpdateHandle } from "../lib/updateFlow";
import { IDLE_FOR_MS } from "../lib/updateIdle";
import { setPlatformForTests } from "../lib/platform";
import { useTiles, type Tile } from "../store/tileStore";
import { useUi } from "../store/uiStore";
import { useBuilder } from "../store/builderStore";
import { act, renderUi, tauri, waitFor } from "./render";
import { boardCard, seedBoard } from "./boardFixtures";
import type { KanbanCard } from "../ipc";

const NOW = Date.now();
const OLD_INPUT = NOW - IDLE_FOR_MS - 1;

function tiles(list: Partial<Tile>[]) {
  act(() =>
    useTiles.setState({
      byWorkspace: { w1: { tiles: list as Tile[], expandedTileId: null, detailTileId: null } },
    } as never),
  );
}

function fakeFlow() {
  const idleMoment = vi.fn(async () => {});
  return { flow: { idleMoment } as unknown as UpdateFlow, idleMoment };
}

beforeEach(() => {
  // jsdom's window is never in front; Plyloft's is, in these looks.
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  act(() => useUi.setState({ settingsOverlayOpen: false, palette: { open: false, scope: "commands" } }));
});

afterEach(() => {
  vi.restoreAllMocks();
  setUpdateFlowForTests(null);
  setPlatformForTests(null);
  tiles([]);
});

describe("the idle look", () => {
  const shell = { id: "s1", kind: "shell", status: "running", ptyId: "pty-s1", pendingClose: false, startedAt: 0 } as Partial<Tile>;

  it("waits while a shell runs a command, or can't say", async () => {
    tiles([shell]);
    for (const answer of [true, null]) {
      tauri().fixture("pty_command_running", answer);
      const { flow, idleMoment } = fakeFlow();
      let looks = await lookForIdle(flow, OLD_INPUT, 0, NOW);
      looks = await lookForIdle(flow, OLD_INPUT, looks, NOW);
      expect(looks).toBe(0);
      expect(idleMoment).not.toHaveBeenCalled();
    }
    expect(tauri().callsOf("pty_command_running")[0].args).toEqual({ id: "pty-s1" });
  });

  it("installs after two idle looks with the shell at its prompt", async () => {
    tiles([shell]);
    tauri().allowUnhandled(); // the install is logged
    tauri().fixture("pty_command_running", false);
    const { flow, idleMoment } = fakeFlow();
    const one = await lookForIdle(flow, OLD_INPUT, 0, NOW);
    expect(one).toBe(1);
    expect(idleMoment).not.toHaveBeenCalled();
    await lookForIdle(flow, OLD_INPUT, one, NOW);
    expect(idleMoment).toHaveBeenCalledTimes(1);
  });

  // 1.176.2 (F1 review round 3, M1): the install the two looks start asks
  // the same look once more right before it goes in.
  it("gives the install the idle look again, which sees work started since", async () => {
    tiles([shell]);
    tauri().allowUnhandled(); // the install is logged
    tauri().fixture("pty_command_running", false);
    const idleMoment = vi.fn(async (_stillIdle?: () => Promise<boolean>) => {});
    const flow = { idleMoment } as unknown as UpdateFlow;
    await lookForIdle(flow, OLD_INPUT, await lookForIdle(flow, OLD_INPUT, 0, NOW), NOW);
    expect(idleMoment).toHaveBeenCalledTimes(1);
    const stillIdle = idleMoment.mock.calls[0][0]!;
    expect(await stillIdle()).toBe(true);
    // A Builder started during the download, its card not shown.
    act(() =>
      useBuilder.setState({
        byCard: { c1: { workspaceId: "w1", ptyId: "pty-b1", vendor: "codex", startedAt: Date.now(), pending: [] } },
      }),
    );
    try {
      expect(await stillIdle()).toBe(false);
    } finally {
      act(() => useBuilder.setState({ byCard: {} }));
    }
  });

  // 1.176.3 phase 2: the same re-check reads the off-screen Builders'
  // screens anew: idle and still, the install goes; a turn since, it holds.
  it("the re-check before the install reads a Builder no terminal shows from its screen, now", async () => {
    tauri().allowUnhandled(); // the install is logged
    seedBoard([
      boardCard("c1", {
        columnId: "in_progress",
        builder: { vendor: "codex", bypass: false, ptyId: "pty-c1", sessionLost: false, startedAt: NOW - 600_000, snapshots: [] },
      } as Partial<KanbanCard>),
    ]);
    const rows = (status: string) => ["• f5.txt has 15 lines.", "", status, "", "› Ask Codex to do anything", "", "  ← for agents · ? for shortcuts"];
    const said = (status: string, printedAgo: number, changedAgo: number) => [
      { key: "c1", vendor: "codex", exited: false, lastOutputAt: Date.now() - printedAgo, rows: rows(status), contentChangedAt: Date.now() - changedAgo },
    ];
    try {
      // Idle past its turn-done line, nothing printed or changed for a minute.
      tauri().fixture("builder_session_screens", said("  Worked for 21s • 11:22", 60_000, 60_000));
      const idleMoment = vi.fn(async (_stillIdle?: () => Promise<boolean>) => {});
      const flow = { idleMoment } as unknown as UpdateFlow;
      await lookForIdle(flow, OLD_INPUT, await lookForIdle(flow, OLD_INPUT, 0, NOW), NOW);
      expect(idleMoment).toHaveBeenCalledTimes(1);
      const stillIdle = idleMoment.mock.calls[0][0]!;
      expect(await stillIdle()).toBe(true);
      // A turn started during the download.
      tauri().fixture("builder_session_screens", said("• Working (3s • esc to interrupt)", 100, 0));
      expect(await stillIdle()).toBe(false);
    } finally {
      seedBoard([]);
    }
  });

  it("waits for an unsent draft, recent input, Settings and ⌘K", async () => {
    const { flow, idleMoment } = fakeFlow();
    tiles([{ id: "c1", kind: "claude", status: "running", ptyId: "pty-c1", inputEmpty: false, startedAt: 0, lastOutputAt: 0 } as Partial<Tile>]);
    expect(await lookForIdle(flow, OLD_INPUT, 1, NOW)).toBe(0);
    tiles([]);
    expect(await lookForIdle(flow, NOW - 1000, 1, NOW)).toBe(0);
    act(() => useUi.setState({ settingsOverlayOpen: true }));
    expect(await lookForIdle(flow, OLD_INPUT, 1, NOW)).toBe(0);
    act(() => useUi.setState({ settingsOverlayOpen: false, palette: { open: true, scope: "commands" } }));
    expect(await lookForIdle(flow, OLD_INPUT, 1, NOW)).toBe(0);
    // A window in the background is never restarted into view.
    act(() => useUi.setState({ palette: { open: false, scope: "commands" } }));
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    expect(await lookForIdle(flow, OLD_INPUT, 1, NOW)).toBe(0);
    expect(idleMoment).not.toHaveBeenCalled();
  });
});

const order: string[] = [];
const fixtures = {
  quit_listening: null,
  quit_not_listening: null,
  quit_ack: ({ ask }: Record<string, unknown>) => ask === true,
  quit_answer: ({ choice }: Record<string, unknown>) => {
    order.push(`quit_answer:${String(choice)}`);
    return null;
  },
};

/** A flow with "Install when my work is done" chosen and its bytes downloaded. */
async function scheduledFlow(): Promise<UpdateFlow> {
  const handle: UpdateHandle = {
    version: "1.169.0",
    download: async () => {},
    install: async () => {
      order.push("install");
    },
    close: async () => {},
  };
  const flow = new UpdateFlow({ check: async () => handle, relaunch: async () => {}, log: { info: () => {}, error: () => {} } });
  await flow.runCheck("launch");
  flow.installWhenIdle();
  await waitFor(() => expect(flow.canInstallAtQuit()).toBe(true));
  setUpdateFlowForTests(flow);
  return flow;
}

async function askQuit() {
  await waitFor(() => expect(tauri().callsOf("quit_listening")).toHaveLength(1));
  act(() => tauri().emit("app://quit-asked", { generation: 1 }));
}

describe("install at quit", () => {
  beforeEach(() => {
    order.length = 0;
  });

  it("on the Mac: holds the ack, installs, then quits", async () => {
    setPlatformForTests("mac");
    await scheduledFlow();
    renderUi(<QuitGuardSheet />, { fixtures });
    tauri().allowUnhandled();
    await askQuit();
    await waitFor(() => expect(order).toEqual(["install", "quit_answer:quit"]));
    expect(tauri().callsOf("quit_ack")[0].args).toEqual({ generation: 1, ask: true });
  });

  it("on Windows: never installs at quit, and the quit is not held", async () => {
    setPlatformForTests("windows");
    await scheduledFlow();
    renderUi(<QuitGuardSheet />, { fixtures });
    tauri().allowUnhandled();
    await askQuit();
    await waitFor(() => expect(tauri().callsOf("quit_ack")).toHaveLength(1));
    expect(tauri().callsOf("quit_ack")[0].args).toEqual({ generation: 1, ask: false });
    expect(order).toEqual([]);
  });

  it("with nothing scheduled: the ack is not held", async () => {
    setPlatformForTests("mac");
    renderUi(<QuitGuardSheet />, { fixtures });
    tauri().allowUnhandled();
    await askQuit();
    await waitFor(() => expect(tauri().callsOf("quit_ack")).toHaveLength(1));
    expect(tauri().callsOf("quit_ack")[0].args).toEqual({ generation: 1, ask: false });
  });
});
