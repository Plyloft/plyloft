// 1.176.2 F2 (A5F-04): a release that waits for the work presses itself once.
// The drain's poll goes on while its press runs (the drain ends only when
// that press settles); before the fix it armed a second grace and pressed
// again ~12 s later. That second press was refused, and its refusal ended
// the drain (`drain_cancel`) and dropped the first press's progress.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReleaseSheet } from "../components/ReleaseSheet";
import type { KanbanCard } from "../ipc";
import { useKanban } from "../store/kanbanStore";
import { useShip } from "../store/shipStore";
import { useWorkspaces } from "../store/workspaceStore";
import { act, renderUi, screen, waitFor, within } from "./render";
import { PRO_GATES, setPlanGates } from "./planGates";
import { relScope, releaseFixtures } from "./releaseFixtures";
import { pressRunning, releasePressKey } from "../lib/pressOnce";

const WS = "ws-1";
const card = {
  id: "r1",
  workspaceId: WS,
  title: "Blog: RSS feed for posts",
  columnId: "complete",
  verifyStatus: "passed",
  shipStatus: "unshipped",
  worktreePath: "/tmp/ply-test/r1",
  createdAt: 1,
  updatedAt: 1,
} as KanbanCard;

function seed() {
  useWorkspaces.setState({ workspaces: [{ id: WS, name: "lyra", cwd: "/tmp/ply-test" }] as never, activeId: WS });
  useKanban.setState({ byWorkspace: { [WS]: { cards: [card], loaded: true } } } as never);
  setPlanGates(PRO_GATES);
}

/** `release_area` whose first call runs on until `end()`; any other call is
 *  refused, as the backend's ship lock does. `end()` settles the first, so
 *  the project's press slot is free for the next test. */
function firstRunsOn() {
  let calls = 0;
  let refuse: ((e: unknown) => void) | null = null;
  return {
    fixture: () => {
      calls += 1;
      if (calls === 1) return new Promise((_, rej) => (refuse = rej));
      throw "SHIP_BUSY: a release is already running in this project";
    },
    end: async () => {
      vi.useRealTimers();
      await act(async () => {
        refuse?.("ended by the test");
      });
      await waitFor(() => expect(pressRunning(releasePressKey(WS))).toBe(false));
    },
  };
}

async function advance(seconds: number) {
  for (let s = 0; s < seconds; s++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
  }
}

afterEach(() => {
  vi.useRealTimers();
  useShip.setState({ drain: { draining: false, startedAt: null } });
});

describe("a drained release presses once (A5F-04)", () => {
  it("one release_area call over 30 s, the drain stays on, the progress stays", async () => {
    useWorkspaces.setState({ workspaces: [{ id: WS, name: "lyra", cwd: "/tmp/ply-test" }] as never, activeId: WS });
    useKanban.setState({ byWorkspace: { [WS]: { cards: [card], loaded: true } } } as never);
    setPlanGates(PRO_GATES);
    const first = firstRunsOn();
    const r = renderUi(<ReleaseSheet ask={{ workspaceId: WS, areaId: null }} onClose={() => {}} />, {
      fixtures: { ...releaseFixtures(relScope({ readyCardIds: ["r1"] })), release_area: first.fixture, drain_cancel: undefined },
      withToasts: true,
    });
    const sheet = (await screen.findByRole("dialog", { name: "Release lyra" })) as HTMLElement;
    const button = (await within(sheet).findByRole("button", { name: "Release v3.0.2" })) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));

    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    act(() => useShip.setState({ drain: { draining: true, startedAt: 1 } }));
    for (let s = 0; s < 30; s++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
    }
    expect(r.tauri.callsOf("release_area")).toHaveLength(1);
    expect(r.tauri.callsOf("drain_cancel")).toHaveLength(0);
    expect(useShip.getState().drain.draining).toBe(true);
    expect(within(sheet).getByRole("button", { name: "Releasing…" })).toBeTruthy();
    // No second countdown armed while the press runs: the line stays at the
    // one that fired.
    expect(sheet.textContent).toContain("All clear — releasing in 0s.");
    await first.end();
    r.tauri.allowUnhandled();
  });

  // Review M1: the press is kept by the project, not the sheet — closed and
  // opened again while the drained press runs, the new sheet's drain never
  // presses a second time (whose refusal would end the drain).
  it("a sheet opened again mid-press: still one release_area, the drain stays on, it shows Releasing…", async () => {
    seed();
    const first = firstRunsOn();
    const fixtures = { ...releaseFixtures(relScope({ readyCardIds: ["r1"] })), release_area: first.fixture, drain_cancel: undefined };
    const r = renderUi(<ReleaseSheet ask={{ workspaceId: WS, areaId: null }} onClose={() => {}} />, { fixtures, withToasts: true });
    const sheet = (await screen.findByRole("dialog", { name: "Release lyra" })) as HTMLElement;
    const button = (await within(sheet).findByRole("button", { name: "Release v3.0.2" })) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    act(() => useShip.setState({ drain: { draining: true, startedAt: 1 } }));
    await advance(14);
    expect(r.tauri.callsOf("release_area")).toHaveLength(1);
    // Close, then Release… again: a fresh sheet, the drain still on.
    r.unmount();
    const again = renderUi(<ReleaseSheet ask={{ workspaceId: WS, areaId: null }} onClose={() => {}} />, { fixtures, withToasts: true });
    await advance(2);
    const reopened = screen.getByRole("dialog", { name: "Release lyra" }) as HTMLElement;
    await advance(30);
    expect(again.tauri.callsOf("release_area")).toHaveLength(1);
    expect(again.tauri.callsOf("drain_cancel")).toHaveLength(0);
    expect(useShip.getState().drain.draining).toBe(true);
    expect(within(reopened).getByRole("button", { name: "Releasing…" })).toBeTruthy();
    await first.end();
    again.tauri.allowUnhandled();
  });

  it("a press that ends frees the next one: a refused press leaves Release ready again", async () => {
    let n = 0;
    let refuse!: (e: unknown) => void;
    const first = new Promise((_, rej) => {
      refuse = rej;
    });
    useWorkspaces.setState({ workspaces: [{ id: WS, name: "lyra", cwd: "/tmp/ply-test" }] as never, activeId: WS });
    useKanban.setState({ byWorkspace: { [WS]: { cards: [card], loaded: true } } } as never);
    setPlanGates(PRO_GATES);
    const r = renderUi(<ReleaseSheet ask={{ workspaceId: WS, areaId: null }} onClose={() => {}} />, {
      fixtures: {
        ...releaseFixtures(relScope({ readyCardIds: ["r1"] })),
        // The first press waits, then is refused; the next goes through.
        release_area: () => {
          n += 1;
          return n === 1 ? first : { commitSha: "abc12345", shippedVersion: "3.0.2", releaseKind: "push_only", installLog: "", tag: "v3.0.2" };
        },
        kanban_load: { cards: [] },
      },
      withToasts: true,
    });
    const sheet = (await screen.findByRole("dialog", { name: "Release lyra" })) as HTMLElement;
    const button = (await within(sheet).findByRole("button", { name: "Release v3.0.2" })) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    // A double click while the first press runs: one call.
    await r.user.dblClick(button);
    await waitFor(() => expect(r.tauri.callsOf("release_area")).toHaveLength(1));
    await act(async () => {
      refuse("the tag v3.0.2 exists already");
    });
    // Settled and refused: the next press goes.
    const again = (await within(sheet).findByRole("button", { name: "Release v3.0.2" })) as HTMLButtonElement;
    await waitFor(() => expect(again.disabled).toBe(false));
    await r.user.click(again);
    await waitFor(() => expect(r.tauri.callsOf("release_area")).toHaveLength(2));
    expect(await screen.findByRole("dialog", { name: "v3.0.2 is released" })).toBeTruthy();
    r.tauri.allowUnhandled();
  });
});
