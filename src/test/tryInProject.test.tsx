// Try it TI-5 (docs/try-it/TRY_IT_SPEC.md §3.2): after Ship, Try it in
// <project> — over the real stores and TI-2's real Try session (a shell
// tile; its "terminal" is a stand-in that gives each new tile a PTY and a
// prompt, as `Terminal` would).
//
//  1. Offered on the Ship receipt and the Shipped toast only with a start
//     command, and only after a local merge (never after a pull request).
//  2. It runs in the project folder as the workspace's own Try session, and
//     Code's preview opens on the address it prints (or a common port that
//     opened after the start); an https one goes to the browser.
//  3. The preview's target is cleared when its session stops.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KanbanCard, ShipOutcome, TryCommandView } from "../ipc";
import { CardShipStep } from "../components/CardShipStep";
import { OutcomeScreen } from "../components/OutcomeScreen";
import { ProjectTryStrip } from "../components/ProjectTryStrip";
import { useTiles } from "../store/tileStore";
import { useToasts } from "../store/toastStore";
import { useUi } from "../store/uiStore";
import { useWorkspaces } from "../store/workspaceStore";
import { pressTryInProject, stopTryWatchesForTests, useTryRuns } from "../store/tryRunStore";
import { PROJECT_TRY_ID } from "../lib/tryTile";
import { projectTryCard } from "../lib/tryProject";
import { emptyRun, tryRunKey } from "../lib/tryPanel";
import { BOARD_WS, boardCard, seedBoard } from "./boardFixtures";
import { act, fireEvent, renderUi, screen, tauri, waitFor, within } from "./render";

const WS = BOARD_WS;
const ROOT = "/r/lyra";
const PROJECT_KEY = tryRunKey(WS, PROJECT_TRY_ID, null);

const view = (over: Partial<TryCommandView> = {}): TryCommandView => ({
  command: "npm run dev",
  approved: true,
  shared: false,
  readOnly: false,
  hasConfig: true,
  detection: { kind: "none" },
  ...over,
});

function withWorkspace() {
  useWorkspaces.setState({
    workspaces: [{ id: WS, name: "lyra", cwd: ROOT, createdAt: 1, lastOpenedAt: 1, openFiles: [], activeFile: null }],
    activeId: WS,
  });
}

function tiles() {
  return useTiles.getState().byWorkspace[WS]?.tiles ?? [];
}

function writes(): string[] {
  return tauri()
    .callsOf("pty_write")
    .map((c) => new TextDecoder().decode(new Uint8Array(c.args.data as number[])));
}

let ptys = 0;
let offTerminal: (() => void) | null = null;
function fakeTerminal() {
  offTerminal?.();
  offTerminal = useTiles.subscribe(() => {
    for (const t of tiles()) {
      if (!t.ptyId) {
        ptys += 1;
        useTiles.getState().setPtyId(t.id, `pty-${ptys}`);
        useTiles.getState().markOutput(`pty-${ptys}`);
      }
    }
  });
}

afterEach(() => {
  offTerminal?.();
  offTerminal = null;
  stopTryWatchesForTests();
});

function print(text: string) {
  const tile = tiles().find((t) => t.tryOf && !t.pendingClose);
  act(() => {
    tauri().emit("pty://data", { id: tile!.ptyId, data: Array.from(new TextEncoder().encode(text)) });
  });
}

const SESSION_FIXTURES = {
  project_try_command_get: view(),
  try_project_needs_packages: null,
  pty_command_running: null,
  pty_prompt_state: null,
  pty_write: null,
  pty_kill: null,
  probe_localhost_ports: [],
  try_cmd_shims_available: [],
};

function startProject(fixtures: Record<string, unknown> = {}, opts: { fakeTimers?: boolean } = {}) {
  withWorkspace();
  fakeTerminal();
  const r = renderUi(<ProjectTryStrip workspaceId={WS} />, {
    fixtures: { ...SESSION_FIXTURES, ...(fixtures as Record<string, never>) },
    fakeTimers: opts.fakeTimers,
    withToasts: true,
  });
  const press = () =>
    act(async () => {
      pressTryInProject(WS);
      for (let i = 0; i < 8; i++) await Promise.resolve();
    });
  return { ...r, press };
}

const run = () => useTryRuns.getState().runs[PROJECT_KEY];
const target = () => useUi.getState().codePreviewTarget[WS] ?? null;

describe("Try it in <project> runs in the project folder", () => {
  it("starts the workspace's own Try session there, opens Code, and the preview on the printed address", async () => {
    const { press } = startProject();
    await press();
    await waitFor(() => expect(writes()).toEqual(["npm run dev\r"]));
    const tile = tiles().find((t) => t.tryOf)!;
    expect(tile.cwd).toBe(ROOT);
    expect(tile.tryOf?.cardId).toBe(PROJECT_TRY_ID);
    expect(tile.label).toBe("Try · lyra");
    expect(useUi.getState().centerMode[WS]).toBe("code");
    expect(useUi.getState().codePreviewOpen[WS]).toBe(true);
    expect(screen.getByText("Starting your app…")).toBeTruthy();

    print("  VITE v5  ready\r\n  ➜  Local:   http://localhost:5173/\r\n");
    await waitFor(() => expect(run()?.phase).toBe("running"));
    expect(target()?.address).toBe("http://localhost:5173/");
    expect(useUi.getState().browserMode[WS]).toBe("localhost");
    const strip = within(screen.getByRole("region", { name: "Try it in lyra" }));
    expect(strip.getByText("Running on localhost:5173")).toBeTruthy();
    expect(strip.getByRole("button", { name: "Stop" })).toBeTruthy();
    expect(strip.getByRole("button", { name: "Show the session" })).toBeTruthy();
  });

  it("one per workspace: a second press starts nothing more", async () => {
    const { press } = startProject();
    await press();
    await waitFor(() => expect(writes()).toHaveLength(1));
    await press();
    expect(tiles().filter((t) => t.tryOf)).toHaveLength(1);
    expect(writes()).toHaveLength(1);
  });

  it("sends an https address to the browser: a toast with Open in browser, no preview target", async () => {
    const { press } = startProject({ open_web_link: null });
    await press();
    await waitFor(() => expect(writes()).toHaveLength(1));
    print("  ➜  Local:   https://localhost:5173/\r\n");
    await waitFor(() => expect(run()?.phase).toBe("running"));
    expect(target()).toBeNull();
    const toast = useToasts.getState().toasts.find((t) => t.title === "Your app is running on localhost:5173");
    expect(toast?.action?.label).toBe("Open in browser");
    act(() => toast!.action!.onClick());
    await waitFor(() => expect(tauri().callsOf("open_web_link")).toHaveLength(1));
    expect(JSON.stringify(tauri().callsOf("open_web_link")[0].args)).toContain("https://localhost:5173/");
  });

  it("with nothing printed, takes a common port that opened after the start, never one open before", async () => {
    let open = [3000];
    const { press } = startProject({ probe_localhost_ports: () => open }, { fakeTimers: true });
    await press();
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    await waitFor(() => expect(writes()).toHaveLength(1));
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(run()?.address).toBeNull();
    open = [3000, 5173];
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(run()?.address).toBe("http://localhost:5173/");
    expect(target()?.address).toBe("http://localhost:5173/");
    // The project folder has no port block: the card ports' probe is never asked.
    expect(tauri().callsOf("probe_ports")).toHaveLength(0);
  });

  it("installs the project's packages there first, when they are missing", async () => {
    let installed = false;
    const { press, user } = startProject({
      try_project_needs_packages: () => (installed ? null : { command: "pnpm install --frozen-lockfile", creates: null }),
      try_install_packages_in_project: () => {
        installed = true;
        return { state: "done", at: 2 };
      },
    });
    await press();
    const strip = within(screen.getByRole("region", { name: "Try it in lyra" }));
    expect(
      strip.getByText('Your project has no packages yet. Install them with "pnpm install --frozen-lockfile" in your project\'s folder?'),
    ).toBeTruthy();
    expect(tauri().callsOf("try_project_needs_packages")[0].args).toEqual({ workspaceId: WS });
    // The card copies' check is not the one asked here.
    expect(tauri().callsOf("try_copy_needs_packages")).toHaveLength(0);
    await user.click(strip.getByRole("button", { name: "Install and try" }));
    await waitFor(() => expect(writes()).toEqual(["npm run dev\r"]));
    expect(tauri().callsOf("try_install_packages_in_project")[0].args).toEqual({ workspaceId: WS, command: "pnpm install --frozen-lockfile" });
    // Worktree setup is about cards' copies: neither read nor run here.
    expect(tauri().callsOf("worktree_settings_get")).toHaveLength(0);
    expect(tauri().callsOf("card_worktree_setup_retry")).toHaveLength(0);
  });

  it("clears the preview's target when its session stops, so the strip never reopens on a dead port", async () => {
    const { press, user } = startProject();
    await press();
    await waitFor(() => expect(writes()).toHaveLength(1));
    print("Local: http://localhost:5173/\r\n");
    await waitFor(() => expect(target()?.address).toBe("http://localhost:5173/"));
    await user.click(within(screen.getByRole("region", { name: "Try it in lyra" })).getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(run()?.phase).toBe("stopped"));
    expect(target()).toBeNull();
    expect(tauri().callsOf("pty_kill")).toHaveLength(1);
    expect(screen.getByText("Stopped")).toBeTruthy();
  });

  it("a card's session stopping clears the target only when it is that session's address", async () => {
    const { press } = startProject();
    await press();
    await waitFor(() => expect(writes()).toHaveLength(1));
    print("Local: http://localhost:5173/\r\n");
    await waitFor(() => expect(target()?.address).toBe("http://localhost:5173/"));
    // Another session (a card's) on another address ends: the target stays.
    const cardKey = tryRunKey(WS, "c1", null);
    act(() =>
      useTryRuns.setState((s) => ({ runs: { ...s.runs, [cardKey]: { ...run()!, address: "http://localhost:41000/" } } })),
    );
    act(() => useTryRuns.setState((s) => ({ runs: { ...s.runs, [cardKey]: { ...s.runs[cardKey]!, phase: "stopped" } } })));
    expect(target()?.address).toBe("http://localhost:5173/");
    // The card's board loading never forgets the project's session.
    act(() => seedBoard([], { name: "lyra", cwd: ROOT }));
    expect(run()?.phase).toBe("running");
  });

  it("never takes a common port another Try session's address is on", async () => {
    let open: number[] = [];
    const { press } = startProject({ probe_localhost_ports: () => open }, { fakeTimers: true });
    await press();
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    await waitFor(() => expect(writes()).toHaveLength(1));
    // A card's app came up on 5173 meanwhile; the project's own on 3000.
    const cardKey = tryRunKey(WS, "c1", null);
    act(() =>
      useTryRuns.setState((s) => ({
        runs: { ...s.runs, [cardKey]: { ...run()!, phase: "running", address: "http://localhost:5173/" } },
      })),
    );
    open = [5173];
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(run()?.address).toBeNull();
    open = [3000, 5173];
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(run()?.address).toBe("http://localhost:3000/");
  });

  it("a workspace removed while its session runs: the run goes and the session is stopped", async () => {
    const { press } = startProject();
    await press();
    await waitFor(() => expect(writes()).toHaveLength(1));
    print("Local: http://localhost:5173/\r\n");
    await waitFor(() => expect(run()?.phase).toBe("running"));
    act(() => useWorkspaces.setState({ workspaces: [], activeId: null }));
    expect(run()).toBeUndefined();
    await waitFor(() => expect(tauri().callsOf("pty_kill")).toHaveLength(1));
  });

  it("someone on another workspace is not moved: the strip is set up for when they come back", async () => {
    const { press } = startProject();
    await press();
    await waitFor(() => expect(writes()).toHaveLength(1));
    // They went to another workspace's Board while it started.
    act(() => {
      useWorkspaces.setState((s) => ({
        workspaces: [...s.workspaces, { ...s.workspaces[0], id: "ws-other", name: "other" }],
        activeId: "ws-other",
      }));
      useUi.getState().setCenterMode("ws-other", "board");
    });
    print("Local: http://localhost:5173/\r\n");
    await waitFor(() => expect(run()?.phase).toBe("running"));
    expect(useWorkspaces.getState().activeId).toBe("ws-other");
    expect(useUi.getState().centerMode["ws-other"]).toBe("board");
    expect(target()?.address).toBe("http://localhost:5173/");
    expect(useUi.getState().codePreviewOpen[WS]).toBe(true);
  });

  it("the stand-in card it runs as is the workspace's own folder, with no port block", () => {
    const c = projectTryCard({ id: WS, name: "lyra", cwd: ROOT });
    expect([c.id, c.workspaceId, c.title, c.worktreePath, c.portBase]).toEqual([PROJECT_TRY_ID, WS, "lyra", ROOT, null]);
  });
});

// ── Where it is offered ─────────────────────────────────────────────────

const LOCAL_SHIP = { commitSha: "abc1234", shippedVersion: "1.2.0", releaseKind: "local" as const, shippedAt: 1 };

function shippedCard(patch: Partial<KanbanCard> = {}): KanbanCard {
  return boardCard("c1", {
    title: "Dark mode",
    columnId: "complete",
    shipStatus: "shipped",
    shipHistory: [LOCAL_SHIP],
    ...patch,
  } as Partial<KanbanCard>);
}

const RECEIPT_FIXTURES = {
  improvement_proposal_state: null,
  improvement_proposal_trust_stopped: null,
  ship_pending_release: { release: null, unreadable: null },
};

function renderReceipt(c: KanbanCard, command: string | null) {
  withWorkspace();
  const r = renderUi(<CardShipStep card={c} onOpenRelease={() => {}} />, {
    fixtures: { ...RECEIPT_FIXTURES, project_try_command_get: view({ command }) },
  });
  r.tauri.allowUnhandled();
  return r;
}

describe("the Ship receipt offers Try it in <project>", () => {
  it("after a local merge, when the project has a start command", async () => {
    fakeTerminal();
    tauri().fixture("try_project_needs_packages", null);
    tauri().fixture("probe_localhost_ports", []);
    tauri().fixture("pty_write", null);
    tauri().fixture("try_cmd_shims_available", []);
    tauri().fixture("pty_command_running", null);
    tauri().fixture("pty_prompt_state", null);
    const { user } = renderReceipt(shippedCard(), "npm run dev");
    const button = await screen.findByRole("button", { name: "Try it in lyra" });
    await user.click(button);
    await waitFor(() => expect(writes()).toEqual(["npm run dev\r"]));
    expect(tiles().find((t) => t.tryOf)?.cwd).toBe(ROOT);
    expect(useUi.getState().centerMode[WS]).toBe("code");
  });

  it("not when the project has no start command", async () => {
    renderReceipt(shippedCard(), null);
    await waitFor(() => expect(tauri().callsOf("project_try_command_get")).toHaveLength(1));
    await act(async () => {});
    expect(screen.queryByRole("button", { name: "Try it in lyra" })).toBeNull();
  });

  const prMerged = () =>
    shippedCard({
      prUrl: "https://github.com/o/r/pull/9",
      pr: { number: 9, state: "merged", mergeCommit: "abc1234", checkedAt: 2 } as never,
      reviewStatus: "merged",
      shipHistory: [{ ...LOCAL_SHIP, releaseKind: "push_only" }],
    });

  it("after a merged pull request, once the project folder holds its merge commit", async () => {
    tauri().fixture("try_project_has_commit", true);
    renderReceipt(prMerged(), "npm run dev");
    expect(await screen.findByRole("button", { name: "Try it in lyra" })).toBeTruthy();
    expect(tauri().callsOf("try_project_has_commit")[0].args).toEqual({ workspaceId: WS, sha: "abc1234" });
  });

  it("not after a merged pull request the project folder hasn't pulled yet", async () => {
    tauri().fixture("try_project_has_commit", false);
    renderReceipt(prMerged(), "npm run dev");
    await waitFor(() => expect(tauri().callsOf("try_project_has_commit")).toHaveLength(1));
    await act(async () => {});
    expect(screen.queryByRole("button", { name: "Try it in lyra" })).toBeNull();
  });

  it("not after a pull request that is open, or shipped before pull requests were read back", async () => {
    const { unmount } = renderReceipt(
      shippedCard({ prUrl: "https://github.com/o/r/pull/9", pr: { number: 9, state: "open", checkedAt: 2 } as never }),
      "npm run dev",
    );
    await act(async () => {});
    expect(screen.queryByRole("button", { name: "Try it in lyra" })).toBeNull();
    unmount();
    renderReceipt(shippedCard({ prUrl: "https://github.com/o/r/pull/9", pr: null }), "npm run dev");
    await act(async () => {});
    expect(screen.queryByRole("button", { name: "Try it in lyra" })).toBeNull();
    expect(tauri().callsOf("project_try_command_get")).toHaveLength(0);
    expect(tauri().callsOf("try_project_has_commit")).toHaveLength(0);
  });

  it("after a go-live step, says to wait for the rebuild first", async () => {
    act(() => useTryRuns.getState().noteGoLive(WS, "c1"));
    renderReceipt(shippedCard(), "npm run dev");
    expect(await screen.findByRole("button", { name: "Try it in lyra" })).toBeTruthy();
    expect(screen.getByText("Plyloft is rebuilding your app first; try it when that has finished.")).toBeTruthy();
    expect(screen.queryByText("The change is in your project now. See it running there.")).toBeNull();
  });

  it("not before the card shipped", async () => {
    renderReceipt(shippedCard({ shipStatus: "unshipped", shipHistory: [] } as Partial<KanbanCard>), "npm run dev");
    await act(async () => {});
    expect(screen.queryByRole("button", { name: "Try it in lyra" })).toBeNull();
    expect(tauri().callsOf("project_try_command_get")).toHaveLength(0);
  });
});

const OUTCOME_FIXTURES = {
  card_outcome: { filesChanged: 1, verifyConfigured: false, isRecon: false, reconVerdictNegative: false },
  improvement_proposal_state: null,
  improvement_proposal_trust_stopped: null,
  reviewer_list: [],
  verify_status: null,
  card_overlap_check: [],
  card_review_tip: null,
  ship_pending_release: { release: null, unreadable: null },
  card_review_diff: { cardId: "c1", baseBranch: "main", cardBranch: "plyloft/card-c1", files: [], generatedAt: 1 },
};

async function shipWith(res: ShipOutcome, command: string | null) {
  withWorkspace();
  const card = boardCard("c1", {
    title: "Dark mode",
    columnId: "complete",
    lastRunStatus: "success",
    verifyStatus: "passed",
    worktreePath: "/tmp/wt/c1",
    branchName: "plyloft/card-c1",
  } as Partial<KanbanCard>);
  act(() => seedBoard([card], { name: "lyra", cwd: ROOT }));
  let runner: ((mode: "merge_live" | "pr") => Promise<void>) | null = null;
  const r = renderUi(
    <OutcomeScreen workspaceId={WS} card={card} onShipReady={(run) => (runner = run as typeof runner)} />,
    {
      withToasts: true,
      fixtures: { ...OUTCOME_FIXTURES, card_ship: res, kanban_load: [card], project_try_command_get: view({ command }) },
    },
  );
  r.tauri.allowUnhandled();
  await waitFor(() => expect(runner).not.toBeNull());
  await act(async () => {
    await runner!(res.kind === "pr" ? "pr" : "merge_live");
  });
  return useToasts.getState().toasts;
}

const merged = (over: Partial<ShipOutcome> = {}): ShipOutcome =>
  ({ kind: "local_merge", merged: true, conflictingPaths: [], fellBack: false, ...over }) as ShipOutcome;

describe("the Shipped toast offers Try it in <project>", () => {
  it("after a local merge with a start command", async () => {
    const toasts = await shipWith(merged(), "npm run dev");
    const shipped = toasts.find((t) => t.title === "Shipped");
    expect(shipped?.action?.label).toBe("Try it in lyra");
  });

  it("not after a go-live step, which rebuilds the app detached: the receipt says to wait instead", async () => {
    const toasts = await shipWith(merged({ kind: "merged_live" }), "npm run dev");
    const shipped = toasts.find((t) => t.title === "Shipped");
    expect(shipped).toBeTruthy();
    expect(shipped?.action).toBeUndefined();
    expect(tauri().callsOf("project_try_command_get")).toHaveLength(0);
    expect(useTryRuns.getState().goLive[`${WS}\u0000c1`]).toBe(true);
  });

  it("not without a start command", async () => {
    const toasts = await shipWith(merged(), null);
    const shipped = toasts.find((t) => t.title === "Shipped");
    expect(shipped).toBeTruthy();
    expect(shipped?.action).toBeUndefined();
  });

  it("not after a pull request opened", async () => {
    const toasts = await shipWith(
      { kind: "pr", prUrl: "https://github.com/o/r/pull/9", merged: false, conflictingPaths: [], fellBack: false },
      "npm run dev",
    );
    // QoL 14.2 (C21): the pull request's toast opens it on GitHub, never Try it.
    expect(toasts.find((t) => t.title.startsWith("On GitHub: pull request"))?.action?.label).toBe("Open on GitHub");
    expect(tauri().callsOf("project_try_command_get")).toHaveLength(0);
  });

  it("not after a skill-only ship", async () => {
    const toasts = await shipWith(merged({ skillOnly: true }), "npm run dev");
    expect(toasts.find((t) => t.title === "Shipped")?.action).toBeUndefined();
  });
});

// ── The strip at the top of Code's preview ──────────────────────────────

describe("the project's strip", () => {
  const strip = () => within(screen.getByRole("region", { name: "Try it in lyra" }));

  it("asks this Mac's OK for the repository's command, then starts it; Stop says Stopped", async () => {
    let approved = false;
    const { press, user } = startProject({
      project_try_command_get: () => view({ approved, shared: true }),
      project_try_command_approve: () => {
        approved = true;
        return view({ approved: true });
      },
    });
    await press();
    expect(document.querySelector("[data-ply-project-try]")?.getAttribute("data-ply-project-try")).toBe("ask");
    expect(strip().getByText("Not started")).toBeTruthy();
    expect(strip().getByText(/"npm run dev" comes from this repository and hasn't run on this Mac before\./)).toBeTruthy();
    await user.click(strip().getByRole("button", { name: "Allow and run" }));
    await waitFor(() => expect(writes()).toEqual(["npm run dev\r"]));
    expect(tauri().callsOf("project_try_command_approve")[0].args).toEqual({ workspaceId: WS, command: "npm run dev" });
    expect(strip().getByText("Starting your app…")).toBeTruthy();
    expect(strip().getByRole("button", { name: "Show the session" })).toBeTruthy();
    await user.click(strip().getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(strip().getByText("Stopped")).toBeTruthy());
    expect(strip().getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("after 60 s with no address, asks for it, and shows a typed one", async () => {
    const { press } = startProject({}, { fakeTimers: true });
    await press();
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    await waitFor(() => expect(writes()).toHaveLength(1));
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(strip().getByText("Your app started but Plyloft can't see its address.")).toBeTruthy();
    const field = strip().getByRole("textbox", { name: "Your app's address" });
    act(() => {
      fireEvent.change(field, { target: { value: "localhost:4000" } });
    });
    act(() => {
      fireEvent.click(strip().getByRole("button", { name: "Show it" }));
    });
    expect(run()?.address).toBe("http://localhost:4000/");
    expect(target()?.address).toBe("http://localhost:4000/");
  });

  it("says Couldn't start with the last lines, and offers the other way after a PowerShell quick exit", async () => {
    startProject();
    act(() =>
      useTryRuns.setState({
        runs: {
          [PROJECT_KEY]: {
            ...emptyRun("npm run dev"),
            phase: "failed",
            quickExit: true,
            blocked: "quickExit",
            cmdForm: "npm.cmd run dev",
            lines: ["npm : cannot be loaded"],
          },
        },
      }),
    );
    expect(strip().getByText("Couldn't start")).toBeTruthy();
    expect(strip().getByText("Plyloft can also run it the other way:")).toBeTruthy();
    expect(strip().getByText("npm.cmd run dev")).toBeTruthy();
    expect(strip().getByRole("button", { name: "Try again the other way" })).toBeTruthy();
    expect(strip().getByText("npm : cannot be loaded")).toBeTruthy();
    expect(strip().getByText('Ran "npm run dev" in your project\'s folder')).toBeTruthy();
  });

  it("Couldn't start offers Change how it starts: the project's sheet saves the command, and Try again runs it", async () => {
    let saved = "npm run dev";
    const { press, user } = startProject({
      project_try_command_get: () => view({ command: saved }),
      project_try_command_save: ({ command }: { command: string }) => {
        saved = command;
        return view({ command });
      },
    });
    await press();
    await waitFor(() => expect(writes()).toEqual(["npm run dev\r"]));
    // The command ended at once with nothing found.
    act(() => useTryRuns.setState((s) => ({ runs: { ...s.runs, [PROJECT_KEY]: { ...run()!, phase: "failed", lines: ["missing script: dev"] } } })));
    expect(strip().getByText("Couldn't start")).toBeTruthy();
    await user.click(strip().getByRole("button", { name: "Change how it starts" }));
    const sheet = await screen.findByRole("dialog", { name: "How to start your app" });
    expect(within(sheet).getByText("Plyloft will start your app with this command, in your project's folder.")).toBeTruthy();
    expect(within(sheet).queryByText(/card's own copy/)).toBeNull();
    const field = within(sheet).getByRole("textbox", { name: "Command" }) as HTMLInputElement;
    expect(field.value).toBe("npm run dev");
    await user.clear(field);
    await user.type(field, "npm start");
    await user.click(within(sheet).getByRole("button", { name: "Save and try" }));
    expect(tauri().callsOf("project_try_command_save")[0].args).toEqual({ workspaceId: WS, command: "npm start" });
    await waitFor(() => expect(writes()).toEqual(["npm run dev\r", "npm start\r"]));
    expect(screen.queryByRole("dialog")).toBeNull();
    // The session runs in the project folder, still one per workspace.
    expect(tiles().filter((t) => t.tryOf && !t.pendingClose)).toHaveLength(1);
    expect(tiles().find((t) => t.tryOf && !t.pendingClose)?.cwd).toBe(ROOT);
    // A later Try again reads the saved command.
    act(() => useTryRuns.setState((s) => ({ runs: { ...s.runs, [PROJECT_KEY]: { ...run()!, phase: "failed" } } })));
    await user.click(strip().getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(writes()).toEqual(["npm run dev\r", "npm start\r", "npm start\r"]));
  });

  it("a stopped session offers Change how it starts too; a failed install does not", async () => {
    startProject();
    act(() => useTryRuns.setState({ runs: { [PROJECT_KEY]: { ...emptyRun("npm run dev"), phase: "stopped" } } }));
    expect(strip().getByRole("button", { name: "Change how it starts" })).toBeTruthy();
    act(() =>
      useTryRuns.setState({ runs: { [PROJECT_KEY]: { ...emptyRun("npm run dev"), phase: "failed", installFailed: true } } }),
    );
    expect(strip().queryByRole("button", { name: "Change how it starts" })).toBeNull();
  });
});
