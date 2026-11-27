// 1.168.1 B3 (S0 walk, Finish and check on notes-app): the toast said "Your
// checks are running" on a project with no checks set up. It reads the
// project's checks and says none run.
import { describe, expect, it, vi } from "vitest";
import { NO_CHECKS_TO_RUN } from "../lib/buildBoth";
import { useBuilder } from "../store/builderStore";
import { useToasts } from "../store/toastStore";
import { BOARD_WS, boardCard, seedBoard } from "./boardFixtures";
import { act, tauri, waitFor } from "./render";

let told = "";

async function finishAndCheck(verifyPipeline: unknown[] | null): Promise<string | undefined> {
  seedBoard([boardCard("c1")]);
  const stub = tauri();
  stub.allowUnhandled();
  stub.fixture("builder_done", () => ({
    snapshot: { n: 1, sha: "s", at: 10 },
    newSnapshot: true,
    reselected: false,
    reviewOverridden: false,
    changesRequested: false,
    snapshotVerified: false,
    reviewWaitingOn: null,
  }));
  stub.fixture("kanban_load", () => [boardCard("c1")]);
  stub.fixture("verify_start", () => "verify-1");
  stub.fixture("project_config_get", () => ({ targetBranch: "main", versionFiles: [], verifyPipeline, installScript: null }));
  const inject = vi.spyOn(useBuilder.getState(), "inject").mockImplementation(() => {});
  await act(async () => {
    await useBuilder.getState().done(BOARD_WS, "c1");
  });
  let body: string | undefined;
  await waitFor(() => {
    body = useToasts.getState().toasts.find((t) => t.title === "Work saved")?.body;
    expect(body).toBeTruthy();
  });
  told = String(inject.mock.calls[0]?.[1] ?? "");
  inject.mockRestore();
  return body;
}

describe("Work saved says what runs (1.168.1 B3)", () => {
  it("no checks set up: says none run", async () => {
    const body = await finishAndCheck(null);
    expect(body).toBe(NO_CHECKS_TO_RUN);
    expect(body).not.toMatch(/checks are running/);
    // The Builder is told the same (Challenger, lane B).
    expect(told).toMatch(/No checks are set up for this project, so none run on that snapshot/);
    expect(told).not.toMatch(/Verification is running/);
  });

  it("checks set up: says they are running", async () => {
    const body = await finishAndCheck([{ name: "test", command: "npm test" }]);
    expect(body).toBe("Your checks are running. The result goes back to the Builder.");
    expect(told).toMatch(/Verification is running on that snapshot now/);
  });
});

describe("Keeping it as it is (the override) says what runs (1.168.1 Mac walk)", () => {
  it("no checks set up: never says this round passed them", async () => {
    seedBoard([boardCard("c1")]);
    const stub = tauri();
    stub.allowUnhandled();
    stub.fixture("builder_accept_pushback", () => ({
      snapshot: { n: 2, sha: "abcdef12", at: 10 },
      newSnapshot: false,
      reselected: false,
      reviewOverridden: true,
      changesRequested: false,
      snapshotVerified: true,
    }));
    stub.fixture("kanban_load", () => [boardCard("c1")]);
    stub.fixture("project_config_get", () => ({ targetBranch: "main", versionFiles: [], verifyPipeline: [], installScript: null }));
    const inject = vi.spyOn(useBuilder.getState(), "inject").mockImplementation(() => {});
    await act(async () => {
      await useBuilder.getState().acceptPushback(BOARD_WS, "c1");
    });
    inject.mockRestore();
    const body = useToasts.getState().toasts.find((t) => t.title === "Kept as it is")?.body;
    expect(body).toMatch(/No checks are set up for this project, so there are none to run\./);
    expect(body).not.toMatch(/already passed them/);
  });
});

describe("the setup toast fits the moment (1.168.1 Mac walk)", () => {
  it("on a built card (Try it's setup) it runs before the app, not before the Builder", async () => {
    const { startKanbanSubscriptions } = await import("../store/kanbanStore");
    seedBoard([boardCard("c1", { builder: { vendor: "claude", bypass: false, startedAt: 1 } } as never)]);
    const stub = tauri();
    stub.allowUnhandled();
    startKanbanSubscriptions();
    // The listeners are registered asynchronously.
    await act(async () => {});
    act(() => stub.emit("worktree-setup://started", { workspaceId: BOARD_WS, cardId: "c1", command: "npm ci" }));
    await waitFor(() => expect(useToasts.getState().toasts.some((t) => t.body === "npm ci runs in the card's copy before your app starts.")).toBe(true));
    expect(useToasts.getState().toasts.some((t) => t.body === "npm ci runs before the Builder starts.")).toBe(false);
  });
});
