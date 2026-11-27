// 1.169.1 (R2): a pull request never silently carries other cards' commits.
// The card's real Ship press (`OutcomeScreen`'s runner, which the card's Now
// and "Ship as a PR" call) and the real confirm sheet; only Tauri is a stub.
// `card_ship` answers `carries_local_commits` the way Rust's `pr_carry_stop`
// does (`pr_local_commits_tests.rs`), and a pull request once the person
// chose Ship both (`carryLocalCommits`; 1.171.0 A3, was "Include them and
// ship as a PR").
//
//  1. The stop says how many earlier changes, names their cards when known,
//     folds the commits under Show them and offers Not now and Ship both.
//  2. Not now ships nothing more: one `card_ship` call, no pull request.
//  3. Ship both sends the flag, and the pull request opens.
//  4. The card says where it started: "Started from main on this Mac…".
import { describe, expect, it, vi } from "vitest";
import { OutcomeScreen } from "../components/OutcomeScreen";
import { StartedLocalLine } from "../components/CardDetailPanel";
import type { KanbanCard, LocalCommits, ShipOutcome } from "../ipc";
import { useWorkspaces } from "../store/workspaceStore";
import { useKanban } from "../store/kanbanStore";
import { act, renderUi, screen, waitFor, within } from "./render";

// G4 Challenger 1: the Builder's draft is stubbed — the template by default.
const drafted = vi.hoisted(() => ({ next: null as null | { kind: "draft"; requestId: string } }));
vi.mock("../store/builderStore", async (original) => {
  const real = await original<typeof import("../store/builderStore")>();
  return {
    ...real,
    draftPullRequestFor: async () => {
      const out = drafted.next ?? { kind: "template", why: "stub" };
      drafted.next = null;
      return out;
    },
  };
});

const WS = "ws-1";
const HALF = "Land card: Add a half function";

const card: KanbanCard = {
  id: "card-q",
  workspaceId: WS,
  title: "Add a quarter function",
  columnId: "complete",
  verifyStatus: "passed",
  worktreePath: "/tmp/ply-test/card-q",
  branchName: "plyloft/card-q-add-a-quarter-function",
  worktreeBase: { commit: "7e6e63d2aff1e81180f81783fdb491109a5f99d4", refName: "main", source: "localAhead", originSlug: "acme/web" },
  createdAt: 1,
  updatedAt: 1,
};

const local: LocalCommits = { target: "main", count: 1, subjects: [HALF] };

const stopped: ShipOutcome = {
  kind: "carries_local_commits",
  merged: false,
  conflictingPaths: [],
  fellBack: false,
  localCommits: local,
};

const opened: ShipOutcome = {
  kind: "pr",
  prUrl: "https://github.com/acme/web/pull/109",
  merged: false,
  conflictingPaths: [],
  fellBack: false,
};

type Runner = (mode: "merge_live" | "pr") => Promise<void>;

function render(others: KanbanCard[] = []) {
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
    />,
    {
      withToasts: true,
      fixtures: {
        card_ship: (args: Record<string, unknown>) => (args.carryLocalCommits === true ? opened : stopped),
        card_outcome: { filesChanged: 1, verifyConfigured: false, isRecon: false, reconVerdictNegative: false },
        improvement_proposal_state: null,
        improvement_proposal_trust_stopped: null,
        reviewer_list: [],
        verify_status: null,
        card_overlap_check: [],
        card_review_diff: { cardId: card.id, baseBranch: "main", cardBranch: card.branchName, files: [], generatedAt: 1 },
        kanban_load: [card, ...others],
        dependency_doctor: { tools: [], teamSkills: null, projectSkills: null, microphone: null, whisperModel: null },
      },
    },
  );
  // The press, left running: it waits on the sheet's answer.
  const press = async () => {
    await waitFor(() => expect(runner).not.toBeNull());
    let done: Promise<void> = Promise.resolve();
    act(() => {
      done = runner!("pr");
    });
    return done;
  };
  return { ...view, press };
}

// 1.171.0 A3 (DL-11): earlier changes on this Mac, Ship both / Not now.
const TITLE = "1 earlier change on this Mac isn't on GitHub yet";

describe("Ship as a PR that would carry commits not on GitHub yet (R2)", () => {
  it("says it with Ship both and Not now, the commits under Show them; Not now pushes nothing", async () => {
    const { user, press, tauri } = render();
    const done = press();
    const sheet = await screen.findByRole("dialog", { name: TITLE });
    // The sentence leads; the commits are folded under Show them.
    const sentence = within(sheet).getByText(/Nothing has been pushed yet\./);
    const fold = within(sheet).getByText("Show them");
    expect(sentence.compareDocumentPosition(fold) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(sheet).getByRole("listitem", { hidden: true }).textContent).toBe(HALF);
    expect(within(sheet).getByRole("button", { name: "Ship both" })).toBeTruthy();
    await user.click(within(sheet).getByRole("button", { name: "Not now" }));
    await act(async () => {
      await done;
    });
    expect(tauri.callsOf("card_ship").map((c) => c.args)).toEqual([{ workspaceId: WS, cardId: card.id, mode: "pr" }]);
    expect(screen.queryByText(/^On GitHub: pull request/)).toBeNull();
    expect(screen.queryByRole("dialog", { name: TITLE })).toBeNull();
  });

  it("names the card the earlier change came from", async () => {
    // A card that landed on this Mac (Challenger: only those are named).
    const half: KanbanCard = { ...card, id: "card-h", title: "Add a half function", branchName: "plyloft/card-h", shipStatus: "shipped" };
    useKanban.setState({ byWorkspace: { [WS]: { cards: [card, half], loaded: true } } });
    const { press } = render([half]);
    void press();
    const sheet = await screen.findByRole("dialog", { name: TITLE });
    expect(within(sheet).getByText(/^It's from the card “Add a half function”, shipped only on this Mac\./)).toBeTruthy();
  });

  it("Ship both sends the flag and opens the pull request", async () => {
    const { user, press, tauri } = render();
    const done = press();
    const sheet = await screen.findByRole("dialog", { name: TITLE });
    await user.click(within(sheet).getByRole("button", { name: "Ship both" }));
    await act(async () => {
      await done;
    });
    expect(tauri.callsOf("card_ship").map((c) => c.args)).toEqual([
      { workspaceId: WS, cardId: card.id, mode: "pr" },
      { workspaceId: WS, cardId: card.id, mode: "pr", carryLocalCommits: true },
    ]);
    expect(await screen.findByText(/^On GitHub: pull request/)).toBeTruthy();
  });
});

describe("G4 Reviewer 1: the draft request goes with this press only", () => {
  it("both ship calls of one press carry its request, R2's second one too", async () => {
    drafted.next = { kind: "draft", requestId: "req-9" };
    const { user, press, tauri } = render();
    const done = press();
    const sheet = await screen.findByRole("dialog", { name: TITLE });
    await user.click(within(sheet).getByRole("button", { name: "Ship both" }));
    await act(async () => {
      await done;
    });
    expect(tauri.callsOf("card_ship").map((c) => c.args)).toEqual([
      { workspaceId: WS, cardId: card.id, mode: "pr", prDraftRequest: "req-9" },
      { workspaceId: WS, cardId: card.id, mode: "pr", carryLocalCommits: true, prDraftRequest: "req-9" },
    ]);
  });
});

describe("The card's start on this Mac (R2)", () => {
  it("says it on the card, with the target's name and the count", async () => {
    const { tauri } = renderUi(<StartedLocalLine card={card} />, {
      fixtures: { card_local_base_commits: { target: "main", count: 2, subjects: [HALF, "Land card: Add a triple function"] } },
    });
    expect(await screen.findByText("Started from main on this Mac, which has 2 changes not on GitHub yet.")).toBeTruthy();
    expect(tauri.callsOf("card_local_base_commits")[0]?.args).toEqual({ workspaceId: WS, cardId: card.id });
    // The window comes back: read again.
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(tauri.callsOf("card_local_base_commits")).toHaveLength(2));
  });

  it("says nothing once GitHub has them, and never asks for a card started from GitHub", async () => {
    const { tauri, unmount } = renderUi(<StartedLocalLine card={card} />, { fixtures: { card_local_base_commits: null } });
    await waitFor(() => expect(tauri.callsOf("card_local_base_commits")).toHaveLength(1));
    expect(screen.queryByText(/on this Mac/)).toBeNull();
    unmount();
    renderUi(<StartedLocalLine card={{ ...card, worktreeBase: { ...card.worktreeBase!, source: "origin", refName: "origin/main" } }} />);
    expect(tauri.callsOf("card_local_base_commits")).toHaveLength(1);
  });
});
