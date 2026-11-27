// n16 — the first start in a repository with no project config sets it up
// (the plain proposal Setup's step 9 would save) and goes on, once, instead
// of stopping with "this repository isn't set up yet". Shared settings this
// account can't write, nothing plain to propose, or a failed save keep
// today's refusal with Set up.
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import { act } from "@testing-library/react";
import { CardDetailPanel } from "../components/CardDetailPanel";
import type { KanbanCard, ProjectConfig, SetupConfigView } from "../ipc";
import { useBuilder } from "../store/builderStore";
import { useKanban } from "../store/kanbanStore";
import { useUi } from "../store/uiStore";
import { dismissToast, pushToast, useToasts } from "../store/toastStore";
import { autoSetUpForStart } from "../lib/autoSetUp";
import { BOARD_WS, boardCard, seedBoard } from "./boardFixtures";
import { renderUi, screen, waitFor, within } from "./render";
import { tauri } from "./tauri";

vi.mock("../components/BuilderSession", () => ({
  BuilderSession: () => {
    useEffect(() => {}, []);
    return <div data-testid="builder-terminal" />;
  },
}));
vi.mock("../components/OutcomeScreen", () => ({
  OutcomeScreen: () => <div data-testid="outcome" />,
}));

const NOT_SET_UP =
  "Lyra isn't set up for Plyloft's builds yet, so Plyloft doesn't know which branch to work from. Nothing was started. Open Settings › This repository › Build and release and press Re-detect, then start the card again.";
const READ_ONLY =
  "Lyra isn't set up for Plyloft's builds yet, so Plyloft doesn't know which branch to work from. Nothing was started. Its settings are shared and this account can't write to the repository: someone with write access has to press Re-detect in Settings › This repository › Build and release and publish; then start the card again.";

const proposal = (over: Partial<SetupConfigView> = {}): SetupConfigView => ({
  state: "proposal",
  config: {
    schemaVersion: 2,
    targetBranch: "trunk",
    versionFiles: [],
    installScript: null,
    verifyPipeline: null,
    createdAt: 1,
    updatedAt: 1,
  } as ProjectConfig,
  branches: ["trunk"],
  suggestedBranch: null,
  branchFrom: "head",
  head: "branch",
  headBranch: "trunk",
  detectedVerify: null,
  version: null,
  readOnly: false,
  ...over,
});

/** No origin: `trunk`, the repository's only branch, is safe to build from. */
const NO_ORIGIN = { hasOrigin: false, defaultBranch: null };

function open(card: KanbanCard) {
  seedBoard([card]);
  useUi.setState({ selectedCardId: { [BOARD_WS]: card.id }, centerMode: { [BOARD_WS]: "board" } });
  useBuilder.setState({ byCard: {}, vendorPref: {}, startBusy: {}, errorByCard: {} });
  const view = renderUi(<CardDetailPanel workspaceId={BOARD_WS} />, {
    withToasts: true,
    fixtures: {
      card_overlap_check: [],
      reviewer_list: [],
      verify_status: null,
      improvement_proposal_state: null,
      improvement_proposal_trust_stopped: null,
      ship_pending_release: { release: null, unreadable: null },
      card_review_tip: null,
      builder_start: () => ({}),
      kanban_load: () => [card],
      workspace_definition_get: () => null,
      project_detect_for_setup: () => proposal(),
      project_config_set: () => undefined,
      project_local_origin: () => NO_ORIGIN,
      project_config_list: () => [],
    },
  });
  view.tauri.allowUnhandled();
  return view;
}

const startButton = () => document.querySelector<HTMLButtonElement>("[data-ply-primary-action-id]")!;
const toasts = () => document.querySelector(".toast-stack")!;

/** The K1 order: no config refuses the `.env` read first; once a config is
 *  saved the read answers `files`. */
function refusedUntilSetUp(files: string[] = [], refusal = NOT_SET_UP) {
  tauri().fixture("worktree_env_proposal", () => {
    if (tauri().callsOf("project_config_set").length === 0) throw refusal;
    return files;
  });
}

describe("Start build in a repository with no config", () => {
  it("sets it up with the detected branch, says so, and starts once", async () => {
    const { user, tauri: stub } = open(boardCard("c1", { notes: "Do it" }));
    refusedUntilSetUp();
    await user.click(startButton());
    await waitFor(() => expect(stub.callsOf("builder_start")).toHaveLength(1));
    expect(stub.callsOf("project_detect_for_setup")).toHaveLength(1);
    const saved = stub.callsOf("project_config_set");
    expect(saved).toHaveLength(1);
    expect(saved[0].args.workspaceId).toBe(BOARD_WS);
    expect((saved[0].args.config as ProjectConfig).targetBranch).toBe("trunk");
    await waitFor(() => expect(toasts().textContent).toContain("“Lyra” is set up for builds"));
    expect(toasts().textContent).toContain(
      "Plyloft builds from trunk. Change it in Settings › Cards › Shipping.",
    );
    expect(toasts().textContent).not.toContain("Build not started");
    expect(screen.queryByRole("group", { name: /isn't set up yet/ })).toBeNull();
    // The branch rule reads local refs only: nothing is fetched.
    expect(stub.callsOf("workspace_definition_branches")).toHaveLength(0);
    // The Setup row reads the saved config again.
    await waitFor(() => expect(stub.callsOf("project_config_list").length).toBeGreaterThan(0));
    // Change opens Build and release for this repository.
    await user.click(within(toasts() as HTMLElement).getByRole("button", { name: "Change" }));
    expect(useUi.getState().settingsOverlayOpen).toBe(true);
  });

  // Windows walk of 1.160.0: ~13 s of a bare "Starting…" — while the
  // repository is set up the button says so, and stays off.
  it("says Setting up… while it sets the repository up, then Starting…", async () => {
    const { user, tauri: stub } = open(boardCard("c1", { notes: "Do it" }));
    refusedUntilSetUp();
    let detected: (v: SetupConfigView) => void = () => {};
    stub.fixture("project_detect_for_setup", () => new Promise<SetupConfigView>((r) => (detected = r)));
    let started: (v: unknown) => void = () => {};
    stub.fixture("builder_start", () => new Promise((r) => (started = r)));
    // Every state the button passes through, from the press to the session.
    const seen: { text: string; disabled: boolean }[] = [];
    const record = () => {
      const b = startButton();
      if (b) seen.push({ text: b.textContent ?? "", disabled: b.disabled });
    };
    const observer = new MutationObserver(record);
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    await user.click(startButton());
    await waitFor(() => expect(startButton().textContent).toContain("Setting up…"));
    expect(startButton().disabled).toBe(true);
    // Both reads of the repository were asked at once.
    expect(stub.callsOf("project_local_origin")).toHaveLength(1);
    act(() => detected(proposal()));
    await waitFor(() => expect(startButton().textContent).toContain("Starting…"));
    expect(startButton().textContent).not.toContain("Setting up…");
    expect(startButton().disabled).toBe(true);
    act(() => started({}));
    await waitFor(() => expect(toasts().textContent).toContain("“Lyra” is set up for builds"));
    observer.disconnect();
    // Never an enabled Start build in between: not after the refusal, not
    // after the set-up, not before the retry's start.
    const lastStarting = seen.map((x) => x.text.includes("Starting…")).lastIndexOf(true);
    const untilStarted = seen.slice(0, lastStarting + 1);
    expect(untilStarted.length).toBeGreaterThan(0);
    expect(untilStarted.filter((x) => !x.disabled)).toEqual([]);
    expect(untilStarted.some((x) => x.text.includes("Start build"))).toBe(false);
  });

  it("stays Starting… while the one-time .env question is asked", async () => {
    const { user, tauri: stub } = open(boardCard("c1", { notes: "Do it" }));
    refusedUntilSetUp([".env"]);
    stub.fixture("worktree_env_proposal_answer", () => ({ envProposal: "dontCopy" }));
    await user.click(startButton());
    const sheet = await screen.findByRole("dialog", { name: "Copy this file into cards' copies?" });
    expect(startButton().textContent).toContain("Starting…");
    expect(startButton().disabled).toBe(true);
    await user.click(within(sheet).getByRole("button", { name: "Don't copy" }));
    await waitFor(() => expect(stub.callsOf("builder_start")).toHaveLength(1));
  });

  it("a shared definition: nothing saved (it would publish to the team), today's Set up", async () => {
    const { user, tauri: stub } = open(boardCard("c1", { notes: "Do it" }));
    stub.fixture("worktree_env_proposal", () => {
      throw NOT_SET_UP;
    });
    stub.fixture("workspace_definition_get", () => ({ effective: { schemaVersion: 1 } }));
    await user.click(startButton());
    await waitFor(() =>
      expect(screen.getByRole("group", { name: "Start build didn't start: this repository isn't set up yet." })).toBeTruthy(),
    );
    expect(stub.callsOf("project_config_set")).toHaveLength(0);
    expect(stub.callsOf("project_detect_for_setup")).toHaveLength(0);
    expect(stub.callsOf("builder_start")).toHaveLength(0);
  });

  it("a branch that isn't plainly the one to build from: nothing saved, today's Set up", async () => {
    const { user, tauri: stub } = open(boardCard("c1", { notes: "Do it" }));
    refusedUntilSetUp();
    // HEAD is on `trunk`, but origin builds from `main`.
    stub.fixture("project_local_origin", () => ({ hasOrigin: true, defaultBranch: "main" }));
    await user.click(startButton());
    await waitFor(() =>
      expect(screen.getByRole("group", { name: "Start build didn't start: this repository isn't set up yet." })).toBeTruthy(),
    );
    expect(stub.callsOf("project_local_origin")).toHaveLength(1);
    expect(stub.callsOf("project_config_set")).toHaveLength(0);
    expect(stub.callsOf("builder_start")).toHaveLength(0);
  });

  it("asks the one-time .env question after the set-up, once, before the Builder starts", async () => {
    const { user, tauri: stub } = open(boardCard("c1", { notes: "Do it" }));
    refusedUntilSetUp([".env"]);
    stub.fixture("worktree_env_proposal_answer", () => ({ envProposal: "dontCopy" }));
    await user.click(startButton());
    const sheet = await screen.findByRole("dialog", { name: "Copy this file into cards' copies?" });
    expect(stub.callsOf("project_config_set")).toHaveLength(1);
    expect(stub.callsOf("builder_start")).toHaveLength(0);
    await user.click(within(sheet).getByRole("button", { name: "Don't copy" }));
    await waitFor(() => expect(stub.callsOf("builder_start")).toHaveLength(1));
    expect(stub.callsOf("worktree_env_proposal_answer")).toHaveLength(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shared settings this account can't write: no set-up, today's words", async () => {
    const { user, tauri: stub } = open(boardCard("c1", { notes: "Do it" }));
    refusedUntilSetUp([], READ_ONLY);
    await user.click(startButton());
    await waitFor(() => expect(toasts().textContent).toContain("Someone with write access has to set up this repository first."));
    expect(stub.callsOf("project_detect_for_setup")).toHaveLength(0);
    expect(stub.callsOf("project_config_set")).toHaveLength(0);
    expect(stub.callsOf("builder_start")).toHaveLength(0);
  });

  it("nothing plain to propose: today's refusal with Set up, nothing saved", async () => {
    const { user, tauri: stub } = open(boardCard("c1", { notes: "Do it" }));
    refusedUntilSetUp();
    stub.fixture("project_detect_for_setup", () => proposal({ state: "needsBranch" }));
    await user.click(startButton());
    await waitFor(() =>
      expect(toasts().textContent).toContain("Build not started. Set up this repository, then press Start build."),
    );
    expect(stub.callsOf("project_config_set")).toHaveLength(0);
    expect(stub.callsOf("builder_start")).toHaveLength(0);
    expect(screen.getByRole("group", { name: "Start build didn't start: this repository isn't set up yet." })).toBeTruthy();
  });

  // 1.172 A3 (Windows walk 2026-10-27-163110): the refusal stays until
  // dismissed (Set up is its action); once the build starts it goes, so it
  // never comes back from the queue after the build is running.
  it("the refusal goes once the card's build starts", async () => {
    const { user, tauri: stub } = open(boardCard("c1", { notes: "Do it" }));
    refusedUntilSetUp();
    stub.fixture("project_detect_for_setup", () => proposal({ state: "needsBranch" }));
    await user.click(startButton());
    await waitFor(() =>
      expect(toasts().textContent).toContain("Build not started. Set up this repository, then press Start build."),
    );
    // A newer toast covers it: it waits in the queue.
    act(() => {
      pushToast({ kind: "warn", title: "Something else" });
    });
    expect(useToasts.getState().queue.some((t) => t.title === "Build not started")).toBe(true);
    // Set up elsewhere (Settings), then Start build again — 1.175.0 F8:
    // the refusal leads Now with its Set up until it is dismissed.
    stub.fixture("worktree_env_proposal", () => []);
    await user.click(within(screen.getByRole("group", { name: /isn't set up yet/ })).getByRole("button", { name: "Dismiss" }));
    await user.click(startButton());
    await waitFor(() => expect(stub.callsOf("builder_start")).toHaveLength(1));
    const all = () => [...useToasts.getState().toasts, ...useToasts.getState().queue];
    await waitFor(() => expect(all().some((t) => t.title === "Build not started")).toBe(false));
    act(() => {
      dismissToast(useToasts.getState().toasts[0]?.id ?? "");
    });
    expect(toasts().textContent ?? "").not.toContain("Build not started");
  });

  it("a save that fails: today's refusal with Set up", async () => {
    const { user, tauri: stub } = open(boardCard("c1", { notes: "Do it" }));
    stub.fixture("worktree_env_proposal", () => {
      throw NOT_SET_UP;
    });
    stub.fixture("project_config_set", () => {
      throw "disk full";
    });
    await user.click(startButton());
    await waitFor(() =>
      expect(screen.getByRole("group", { name: "Start build didn't start: this repository isn't set up yet." })).toBeTruthy(),
    );
    expect(stub.callsOf("project_config_set")).toHaveLength(1);
    expect(stub.callsOf("worktree_env_proposal")).toHaveLength(1);
    expect(toasts().textContent).not.toContain("is set up for builds");
  });

  it("refused again after the set-up: one refusal, never a second set-up", async () => {
    const { user, tauri: stub } = open(boardCard("c1", { notes: "Do it" }));
    stub.fixture("worktree_env_proposal", () => {
      throw NOT_SET_UP;
    });
    await user.click(startButton());
    await waitFor(() =>
      expect(screen.getByRole("group", { name: "Start build didn't start: this repository isn't set up yet." })).toBeTruthy(),
    );
    expect(stub.callsOf("project_detect_for_setup")).toHaveLength(1);
    expect(stub.callsOf("project_config_set")).toHaveLength(1);
    expect(stub.callsOf("worktree_env_proposal")).toHaveLength(2);
    expect(toasts().textContent!.split("Build not started").length - 1).toBe(1);
  });
});

describe("a card moved to In progress in a repository with no config", () => {
  it("sets it up and moves the card once", async () => {
    const card = boardCard("c2", { columnId: "todo", title: "Add search" });
    renderUi(<div />, {
      withToasts: true,
      fixtures: {
        project_detect_for_setup: () => proposal(),
        project_config_set: () => undefined,
        workspace_definition_get: () => null,
        project_local_origin: () => NO_ORIGIN,
      },
    });
    seedBoard([card]);
    const stub = tauri();
    stub.allowUnhandled();
    refusedUntilSetUp();
    // The `.env` read refuses first (K1); the move would refuse too.
    let advances = 0;
    stub.fixture("kanban_card_advance_to_in_progress", () => {
      advances += 1;
      if (stub.callsOf("project_config_set").length === 0) throw NOT_SET_UP;
      return { ...card, columnId: "in_progress", worktreePath: "/tmp/w" };
    });
    await act(() => useKanban.getState().moveCard("c2", "in_progress"));
    expect(stub.callsOf("project_config_set")).toHaveLength(1);
    expect(stub.callsOf("worktree_env_proposal")).toHaveLength(2);
    expect(advances).toBe(1);
    expect(useKanban.getState().byWorkspace[BOARD_WS].cards[0].columnId).toBe("in_progress");
    expect(toasts().textContent).toContain("“Lyra” is set up for builds");
  });
});

describe("two starts at once", () => {
  it("share one set-up: one save, one toast", async () => {
    renderUi(<div />, {
      withToasts: true,
      fixtures: {
        workspace_definition_get: () => null,
        project_detect_for_setup: () => proposal(),
        project_local_origin: () => NO_ORIGIN,
        project_config_set: () => undefined,
        project_config_list: () => [],
      },
    });
    seedBoard([]);
    const stub = tauri();
    const [a, b] = await Promise.all([autoSetUpForStart(BOARD_WS), autoSetUpForStart(BOARD_WS)]);
    expect(stub.callsOf("project_config_set")).toHaveLength(1);
    act(() => {
      a!();
      b!();
    });
    expect(toasts().textContent!.split("is set up for builds").length - 1).toBe(1);
  });

  it("a start that finds it already set up goes on, saving and saying nothing", async () => {
    renderUi(<div />, {
      withToasts: true,
      fixtures: {
        workspace_definition_get: () => null,
        project_detect_for_setup: () => proposal({ state: "existing" }),
        // Read beside the detection (Windows walk of 1.160.0), unused here.
        project_local_origin: () => NO_ORIGIN,
      },
    });
    seedBoard([]);
    const stub = tauri();
    const announce = await autoSetUpForStart(BOARD_WS);
    expect(announce).toBeTypeOf("function");
    act(() => announce!());
    expect(stub.callsOf("project_config_set")).toHaveLength(0);
    expect(toasts().textContent).not.toContain("is set up for builds");
  });
});
