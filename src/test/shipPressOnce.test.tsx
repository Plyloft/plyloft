// 1.176.2 F2 (A5F-03): Ship pressed twice ships once. The card's real Ship
// runner (`OutcomeScreen`, which its Now, its Ship step and Other ways all
// call); only Tauri and the Builder's draft are stubs. Before the fix both
// presses ran: two drafts asked of the Builder and two `card_ship` calls.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OutcomeScreen } from "../components/OutcomeScreen";
import type { KanbanCard, ShipOutcome } from "../ipc";
import { useWorkspaces } from "../store/workspaceStore";
import { act, renderUi, screen, waitFor, within } from "./render";

const drafts = vi.hoisted(() => ({ asked: 0 }));
vi.mock("../store/builderStore", async (original) => {
  const real = await original<typeof import("../store/builderStore")>();
  return {
    ...real,
    draftPullRequestFor: async () => {
      drafts.asked += 1;
      return { kind: "template", why: "stub" };
    },
  };
});

const WS = "ws-1";
const card: KanbanCard = {
  id: "card-q",
  workspaceId: WS,
  title: "Add a quarter function",
  columnId: "complete",
  verifyStatus: "passed",
  worktreePath: "/tmp/ply-test/card-q",
  branchName: "plyloft/card-q-add-a-quarter-function",
  worktreeBase: { commit: "7e6e63d2aff1e81180f81783fdb491109a5f99d4", refName: "main", source: "origin", originSlug: "acme/web" },
  createdAt: 1,
  updatedAt: 1,
};

const opened: ShipOutcome = {
  kind: "pr",
  prUrl: "https://github.com/acme/web/pull/109",
  merged: false,
  conflictingPaths: [],
  fellBack: false,
};

type Runner = (mode: "pr") => Promise<void>;

function render(cardShip: (args: Record<string, unknown>) => unknown, onBusy?: (busy: boolean) => void) {
  useWorkspaces.setState({
    workspaces: [{ id: WS, name: "Ply", cwd: "/tmp/ply-test" } as never],
    activeId: WS,
  });
  let runner: Runner | null = null;
  const view = renderUi(
    <OutcomeScreen
      workspaceId={WS}
      card={card}
      onShipReady={(run) => {
        runner = run as Runner | null;
      }}
      onPresentationChange={(p) => onBusy?.(p.shipBusy)}
    />,
    {
      withToasts: true,
      fixtures: {
        card_ship: cardShip,
        card_outcome: { filesChanged: 1, verifyConfigured: false, isRecon: false, reconVerdictNegative: false },
        improvement_proposal_state: null,
        improvement_proposal_trust_stopped: null,
        reviewer_list: [],
        verify_status: null,
        card_overlap_check: [],
        card_review_diff: { cardId: card.id, baseBranch: "main", cardBranch: card.branchName, files: [], generatedAt: 1 },
        kanban_load: [card],
        dependency_doctor: { tools: [], teamSkills: null, projectSkills: null, microphone: null, whisperModel: null },
      },
    },
  );
  /** Presses Ship `times` times in the same tick, as a double click does. */
  const pressTogether = async (times: number) => {
    await waitFor(() => expect(runner).not.toBeNull());
    const runs: Promise<void>[] = [];
    act(() => {
      for (let i = 0; i < times; i++) runs.push(runner!("pr"));
    });
    await act(async () => {
      await Promise.all(runs);
    });
  };
  const run = async () => {
    await waitFor(() => expect(runner).not.toBeNull());
    return runner!;
  };
  return { ...view, pressTogether, run };
}

beforeEach(() => {
  drafts.asked = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
});

const STILL = "Shipping “Add a quarter function” is still running.";

// Review M2: a press long after the running one is the person's — it is
// answered, and a card page opened again mid-ship shows Ship busy.
describe("a Ship pressed while one runs says so (review M2)", () => {
  it("a double click stays quiet; a press more than a second later says it is still running", async () => {
    const waiting: (() => void)[] = [];
    const { run, tauri } = render(() => new Promise((resolve) => waiting.push(() => resolve(opened))));
    const runner = await run();
    let first: Promise<void> = Promise.resolve();
    act(() => {
      first = runner("pr");
      void runner("pr");
    });
    await waitFor(() => expect(tauri.callsOf("card_ship")).toHaveLength(1));
    expect(screen.queryByText(STILL)).toBeNull();
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 5_000);
    await act(async () => {
      await runner("pr");
    });
    expect(await screen.findByText(STILL)).toBeTruthy();
    expect(tauri.callsOf("card_ship")).toHaveLength(1);
    await act(async () => {
      waiting.splice(0).forEach((go) => go());
      await first;
    });
  });

  it("a card page opened again mid-ship shows Ship busy until the ship ends", async () => {
    const waiting: (() => void)[] = [];
    const ship = () => new Promise((resolve) => waiting.push(() => resolve(opened)));
    const first = render(ship);
    const runner = await first.run();
    let pressed: Promise<void> = Promise.resolve();
    act(() => {
      pressed = runner("pr");
    });
    await waitFor(() => expect(first.tauri.callsOf("card_ship")).toHaveLength(1));
    first.unmount();
    let busy = false;
    render(ship, (b) => (busy = b));
    await waitFor(() => expect(busy).toBe(true));
    await act(async () => {
      waiting.splice(0).forEach((go) => go());
      await pressed;
    });
    await waitFor(() => expect(busy).toBe(false));
  });
});

describe("Ship pressed twice ships once (A5F-03)", () => {
  it("two presses in the same tick: one draft request, one card_ship, one toast", async () => {
    const { pressTogether, tauri } = render(() => opened);
    await pressTogether(2);
    expect(tauri.callsOf("card_ship")).toHaveLength(1);
    expect(drafts.asked).toBe(1);
    expect(await screen.findAllByText(/^On GitHub: pull request/)).toHaveLength(1);
    expect(screen.queryByText(/didn't go through|wasn't shipped/)).toBeNull();
  });

  it("is free again after a ship that went through", async () => {
    const { pressTogether, tauri } = render(() => opened);
    await pressTogether(2);
    await pressTogether(1);
    expect(tauri.callsOf("card_ship")).toHaveLength(2);
  });

  it("is free again after a refused ship", async () => {
    let n = 0;
    const { pressTogether, tauri } = render(() => {
      n += 1;
      if (n === 1) throw "SHIP_BUSY: another ship is running in this project";
      return opened;
    });
    await pressTogether(2);
    expect(tauri.callsOf("card_ship")).toHaveLength(1);
    await pressTogether(1);
    expect(tauri.callsOf("card_ship")).toHaveLength(2);
    tauri.allowUnhandled();
  });

  it("is free again after a ship stopped by the person (Not now)", async () => {
    const stopped: ShipOutcome = {
      kind: "carries_local_commits",
      merged: false,
      conflictingPaths: [],
      fellBack: false,
      localCommits: { target: "main", count: 1, subjects: ["Land card: Add a half function"] },
    };
    const { user, tauri, run: runnerOf } = render((args) => (args.carryLocalCommits === true ? opened : stopped));
    const run = await runnerOf();
    // The runner of this mount, pressed twice while the question is up.
    const runs: Promise<void>[] = [];
    const sheetTitle = "1 earlier change on this Mac isn't on GitHub yet";
    act(() => {
      runs.push(run("pr"));
    });
    const sheet = await screen.findByRole("dialog", { name: sheetTitle });
    act(() => {
      runs.push(run("pr"));
    });
    await user.click(within(sheet).getByRole("button", { name: "Not now" }));
    await act(async () => {
      await Promise.all(runs);
    });
    expect(tauri.callsOf("card_ship")).toHaveLength(1);
    // Free again: the next press asks again.
    act(() => {
      runs.push(run("pr"));
    });
    expect(await screen.findByRole("dialog", { name: sheetTitle })).toBeTruthy();
    await waitFor(() => expect(tauri.callsOf("card_ship")).toHaveLength(2));
  });
});
