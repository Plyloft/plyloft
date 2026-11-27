// SL-4 — a card worktree's setup, as the person meets it: the one-time
// question about git-ignored `.env` files before Start build, and a failed
// setup on the card with Retry and Start anyway.
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import { CardDetailPanel } from "../components/CardDetailPanel";
import type { KanbanCard } from "../ipc";
import { useBuilder } from "../store/builderStore";
import { useUi } from "../store/uiStore";
import { BOARD_WS, boardCard, seedBoard } from "./boardFixtures";
import { act } from "@testing-library/react";
import { renderUi, screen, waitFor, within } from "./render";
import { setPlatformForTests } from "../lib/platform";

vi.mock("../components/BuilderSession", () => ({
  BuilderSession: () => {
    useEffect(() => {}, []);
    return <div data-testid="builder-terminal" />;
  },
}));
vi.mock("../components/OutcomeScreen", () => ({
  OutcomeScreen: () => <div data-testid="outcome" />,
}));

function open(card: KanbanCard) {
  seedBoard([card]);
  useUi.setState({ selectedCardId: { [BOARD_WS]: card.id }, centerMode: { [BOARD_WS]: "board" } });
  useBuilder.setState({ byCard: {}, vendorPref: {} });
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
    },
  });
  view.tauri.allowUnhandled();
  return view;
}

const startButton = () =>
  document.querySelector<HTMLButtonElement>("[data-ply-primary-action-id]")!;

describe("the one-time .env question", () => {
  it("asks before the first worktree, lists the files, and sends the answer before the start", async () => {
    const { user, tauri } = open(boardCard("c1", { notes: "Do it" }));
    tauri.fixture("worktree_env_proposal", () => [".env", "apps/web/.env"]);
    tauri.fixture("workspace_definition_get", () => null);
    tauri.fixture("worktree_env_proposal_answer", () => ({ worktreeCopy: [".env", "apps/web/.env"] }));
    await user.click(startButton());
    const sheet = await screen.findByRole("dialog", { name: "Copy these files into cards' copies?" });
    expect(sheet.textContent).toContain(".env and apps/web/.env are ignored by git");
    expect(tauri.callsOf("builder_start")).toHaveLength(0);
    await user.click(within(sheet).getByRole("button", { name: "Copy them" }));
    await waitFor(() => expect(tauri.callsOf("builder_start")).toHaveLength(1));
    expect(tauri.callsOf("worktree_env_proposal_answer")[0].args).toEqual({
      workspaceId: BOARD_WS,
      copy: true,
      files: [".env", "apps/web/.env"],
    });
    const order = tauri.calls.map((c) => c.cmd);
    expect(order.indexOf("worktree_env_proposal_answer")).toBeLessThan(order.indexOf("builder_start"));
  });

  it("keeps a No, sends no file names, and still starts", async () => {
    const { user, tauri } = open(boardCard("c1", { notes: "Do it" }));
    tauri.fixture("worktree_env_proposal", () => [".env"]);
    tauri.fixture("workspace_definition_get", () => null);
    tauri.fixture("worktree_env_proposal_answer", () => ({ envProposal: "dontCopy" }));
    await user.click(startButton());
    // F10: one file is "this file".
    const sheet = await screen.findByRole("dialog", { name: "Copy this file into cards' copies?" });
    expect(sheet.textContent).toContain("starts without it.");
    await user.click(within(sheet).getByRole("button", { name: "Don't copy" }));
    await waitFor(() => expect(tauri.callsOf("builder_start")).toHaveLength(1));
    expect(tauri.callsOf("worktree_env_proposal_answer")[0].args).toEqual({
      workspaceId: BOARD_WS,
      copy: false,
      files: [],
    });
  });

  it("keeps nothing when the sheet is closed without an answer", async () => {
    const { user, tauri } = open(boardCard("c1", { notes: "Do it" }));
    tauri.fixture("worktree_env_proposal", () => [".env"]);
    tauri.fixture("workspace_definition_get", () => null);
    await user.click(startButton());
    await screen.findByRole("dialog", { name: "Copy this file into cards' copies?" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(tauri.callsOf("builder_start")).toHaveLength(1));
    expect(tauri.callsOf("worktree_env_proposal_answer")).toHaveLength(0);
  });

  it("asks nothing when there is nothing to ask", async () => {
    const { user, tauri } = open(boardCard("c1", { notes: "Do it" }));
    tauri.fixture("worktree_env_proposal", () => []);
    await user.click(startButton());
    await waitFor(() => expect(tauri.callsOf("builder_start")).toHaveLength(1));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(tauri.callsOf("worktree_env_proposal_answer")).toHaveLength(0);
  });
});

describe("a failed worktree setup on the card", () => {
  const failed = (): Partial<KanbanCard> => ({
    notes: "Do it",
    columnId: "in_progress",
    worktreePath: "/tmp/wt/c1",
    branchName: "atelier/card-c1",
    worktreeSetup: {
      state: "failed",
      command: "npm ci",
      exitCode: 1,
      reason: "The setup command failed (exit code 1).",
      log: "npm ERR! missing lockfile",
      copied: [".env"],
      unmatched: ["apps/web/.env"],
      at: 1,
    },
  });

  it("says what happened, shows the output, and holds Start build", () => {
    open(boardCard("c1", failed()));
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Setup failed");
    expect(alert.textContent).not.toMatch(/worktree/i);
    expect(alert.textContent).toContain("The setup command failed (exit code 1).");
    expect(within(alert).getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(within(alert).getByRole("button", { name: "Start anyway" })).toBeTruthy();
    const output = screen.getByText("Setup output").closest("details")!;
    expect(output.textContent).toContain("npm ERR! missing lockfile");
    expect(output.textContent).toContain("apps/web/.env — nothing in the main checkout matches it");
    const run = document.querySelector<HTMLElement>('[data-ply-card-section="run"]')!;
    expect((within(run).getByRole("button", { name: "Start build", hidden: true }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("Retry runs the setup again and starts the Builder when it passes", async () => {
    const card = boardCard("c1", failed());
    const { user, tauri } = open(card);
    const passed = { ...card, worktreeSetup: { ...card.worktreeSetup!, state: "done" as const, log: "" } };
    tauri.fixture("card_worktree_setup_retry", () => passed);
    tauri.fixture("kanban_load", () => [passed]);
    await user.click(within(screen.getByRole("alert")).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(tauri.callsOf("builder_start")).toHaveLength(1));
    expect(tauri.callsOf("card_worktree_setup_retry")[0].args).toEqual({ workspaceId: BOARD_WS, cardId: "c1", allow: null });
  });

  it("Retry that fails again says so and starts nothing", async () => {
    const card = boardCard("c1", failed());
    const { user, tauri } = open(card);
    tauri.fixture("card_worktree_setup_retry", () => card);
    await user.click(within(screen.getByRole("alert")).getByRole("button", { name: "Retry" }));
    await screen.findByText("Setup failed again.");
    expect(tauri.callsOf("builder_start")).toHaveLength(0);
  });

  it("a command this Mac hasn't allowed offers Allow and run, which allows exactly that command", async () => {
    const card = boardCard("c1", {
      ...failed(),
      worktreeSetup: {
        state: "failed",
        command: "npm ci",
        approvalNeeded: true,
        reason: "The repository's setup command changed: npm ci. Allow it on this Mac?",
        at: 2,
      },
    });
    const { user, tauri } = open(card);
    const passed = { ...card, worktreeSetup: { state: "done" as const, command: "npm ci", at: 3 } };
    tauri.fixture("card_worktree_setup_retry", () => passed);
    tauri.fixture("kanban_load", () => [passed]);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("The setup command needs your OK");
    expect(within(alert).queryByRole("button", { name: "Retry" })).toBeNull();
    await user.click(within(alert).getByRole("button", { name: "Allow and run" }));
    await waitFor(() => expect(tauri.callsOf("builder_start")).toHaveLength(1));
    expect(tauri.callsOf("card_worktree_setup_retry")[0].args).toEqual({ workspaceId: BOARD_WS, cardId: "c1", allow: "npm ci" });
  });

  it("a setup under way holds Start build and offers nothing to press", () => {
    open(boardCard("c1", { ...failed(), worktreeSetup: { state: "running", command: "npm ci", at: 4 } }));
    // F3: the Now box says so too — not "Ready to start … nothing has started".
    const now = screen.getByRole("region", { name: "Now" });
    expect(now.textContent).toContain("Setting up the card");
    expect(now.textContent).toContain("npm ci is running; the Builder waits for it.");
    expect(now.textContent).not.toContain("nothing has started");
    expect(startButton().textContent).toContain("Start build");
    expect(startButton().disabled).toBe(true);
    // K3 (round 3): the screen reader hears the state and the stable name,
    // even while a press in flight labels the button "Starting…".
    expect(now.querySelector(".ux-sr-only")?.textContent).toBe("Setting up the card. Start build is off.");
    act(() => useBuilder.setState((s) => ({ startBusy: { ...s.startBusy, c1: true } })));
    expect(startButton().textContent).toBe("Starting…");
    expect(now.querySelector(".ux-sr-only")?.textContent).toBe("Setting up the card. Start build is off.");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    const run = document.querySelector<HTMLElement>('[data-ply-card-section="run"]')!;
    // Windows walk of 1.160.0: the run section reads the same start state as
    // the Now box, so it says "Starting…" too, and stays off.
    expect((within(run).getByRole("button", { name: "Starting…", hidden: true }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("the Now box says the setup failed and offers Retry and Start anyway (F5)", async () => {
    const card = boardCard("c1", failed());
    const { user, tauri } = open(card);
    const now = screen.getByRole("region", { name: "Now" });
    expect(now.textContent).toContain("Setup failed");
    expect(now.textContent).toContain("The setup command failed (exit code 1).");
    expect(now.textContent).not.toContain("Ready to start");
    expect(startButton().textContent).toContain("Retry");
    expect(within(now).getByRole("button", { name: "Start anyway" })).toBeTruthy();
    const passed = { ...card, worktreeSetup: { ...card.worktreeSetup!, state: "done" as const, log: "" } };
    tauri.fixture("card_worktree_setup_retry", () => passed);
    tauri.fixture("kanban_load", () => [passed]);
    await user.click(startButton());
    await waitFor(() => expect(tauri.callsOf("builder_start")).toHaveLength(1));
    expect(tauri.callsOf("card_worktree_setup_retry")[0].args).toEqual({ workspaceId: BOARD_WS, cardId: "c1", allow: null });
  });

  it("the Now box offers Allow and run for a command this Mac hasn't allowed", () => {
    open(
      boardCard("c1", {
        ...failed(),
        worktreeSetup: { state: "failed", command: "npm ci", approvalNeeded: true, reason: "The repository's setup command hasn't run on this Mac before: npm ci. Allow it here?", at: 2 },
      }),
    );
    expect(screen.getByRole("region", { name: "Now" }).textContent).toContain("Setup needs your OK");
    expect(startButton().textContent).toContain("Allow and run");
  });

  it("the Allow and run tooltip names the machine as Windows does (n15)", () => {
    setPlatformForTests("windows");
    open(
      boardCard("c1", {
        ...failed(),
        worktreeSetup: { state: "failed", command: "npm ci", approvalNeeded: true, reason: "The repository's setup command hasn't run on this PC before: npm ci. Allow it here?", at: 2 },
      }),
    );
    expect(startButton().closest("[title]")?.getAttribute("title")).toBe(
      "Lets the repository's setup command run on this PC from now on, then starts the Builder.",
    );
  });

  it("a Builder started anyway keeps saying the setup failed (F4)", () => {
    open(
      boardCard("c1", {
        ...failed(),
        lastRunStatus: "running",
        worktreeSetup: { ...failed().worktreeSetup!, state: "skipped" },
        builder: { vendor: "claude", ptyId: null, bypass: false, startedAt: 1, snapshots: [] } as unknown as KanbanCard["builder"],
      }),
    );
    const run = document.querySelector<HTMLElement>('[data-ply-card-section="run"]')!;
    expect(run.textContent).toContain("Setup failed — started anyway");
    expect(run.textContent).toContain("The Builder was started without it.");
  });

  it("Archive while the setup runs is refused at once, with the reason (F6)", async () => {
    const { user, tauri } = open(boardCard("c1", { ...failed(), worktreeSetup: { state: "running", command: "sleep 600", at: 5 } }));
    await user.click(screen.getByRole("button", { name: "More for this card" }));
    await user.click(screen.getByRole("menuitem", { name: "Archive" }));
    expect(await screen.findByText("The card wasn't archived.")).toBeTruthy();
    expect(
      screen.getByText("The card's setup is running in this card's folder. Wait for it to finish, then archive the card."),
    ).toBeTruthy();
    expect(screen.queryByText("Card archived.")).toBeNull();
    expect(useUi.getState().selectedCardId[BOARD_WS]).toBe("c1");
    expect(tauri.callsOf("kanban_card_archive")).toHaveLength(0);
  });

  it("Start anyway lets the Builder start as the worktree is", async () => {
    const card = boardCard("c1", failed());
    const { user, tauri } = open(card);
    const skipped = { ...card, worktreeSetup: { ...card.worktreeSetup!, state: "skipped" as const } };
    tauri.fixture("card_worktree_setup_skip", () => skipped);
    tauri.fixture("kanban_load", () => [skipped]);
    await user.click(within(screen.getByRole("alert")).getByRole("button", { name: "Start anyway" }));
    await waitFor(() => expect(tauri.callsOf("builder_start")).toHaveLength(1));
    expect(tauri.callsOf("card_worktree_setup_skip")).toHaveLength(1);
  });
});
