// E3 (owner, 2026-10-28): after a Claude Code update the owner met "Reviewer
// not re-verified: Claude Code 2.1.312. Claude needs to trust Plyloft's review
// folder first — Settings › Diagnostics › Open Claude there." Now the toast
// says what it means (Claude can't review the cards yet) and carries the
// Diagnostics row's press itself: Open Claude there opens the Claude tile on
// the review folder; Prove it again runs the check now.
import { beforeEach, describe, expect, it } from "vitest";
import { FOLDER_TRUST_REFUSAL } from "../lib/claudeReviewTrust";
import { reviewerPress, startDoctorSubscriptions } from "../store/doctorStore";
import { useTiles } from "../store/tileStore";
import { useToasts } from "../store/toastStore";
import { useUi } from "../store/uiStore";
import { useWorkspaces } from "../store/workspaceStore";
import { act, tauri } from "./render";

const WS = "ws-b";
const FOLDER = "/cfg/claude-sessions";
const event = (detail: string) => ({
  provider: "claude" as const,
  providerName: "Claude Code",
  version: "2.1.312",
  result: "failed" as const,
  level: null,
  detail,
});

const flush = () => act(async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
});

describe("the reviewer's re-check toast carries its own press (E3)", () => {
  beforeEach(() => {
    useWorkspaces.setState({
      workspaces: [{ id: WS, name: "Ply", cwd: "/tmp/ply-b" } as never],
      activeId: WS,
    });
  });

  it("is raised with Open Claude there when the check met Claude's trust question", async () => {
    const stub = tauri();
    stub.allowUnhandled();
    startDoctorSubscriptions();
    await flush();
    act(() => stub.emit("reviewer-capability://auto-probe", event(FOLDER_TRUST_REFUSAL)));
    await flush();
    const toast = useToasts.getState().toasts.find((t) => t.title === "Claude can't review your cards yet");
    expect(toast).toBeTruthy();
    expect(toast!.body).not.toMatch(/Settings ›/);
    expect(toast!.action?.label).toBe("Open Claude there");
  });

  it("Open Claude there opens the Claude tile on the review folder", async () => {
    const stub = tauri();
    stub.allowUnhandled();
    stub.fixture("claude_review_trust_status", { trusted: false, folder: FOLDER });
    useUi.setState({ settingsOverlayOpen: true });
    await act(async () => {
      await reviewerPress("open-trust", event(FOLDER_TRUST_REFUSAL));
    });
    const tiles = useTiles.getState().byWorkspace[WS]?.tiles ?? [];
    expect(tiles.some((t) => t.kind === "claude" && t.cwd === FOLDER)).toBe(true);
    expect(useUi.getState().centerMode[WS]).toBe("terminals");
    // Settings is a modal: it gets out of the way of the tile.
    expect(useUi.getState().settingsOverlayOpen).toBe(false);
  });

  it("Prove it again runs the check now and says it passed", async () => {
    const stub = tauri();
    stub.allowUnhandled();
    stub.fixture("reviewer_capability_probe", { eligible: true, proof: "proved" });
    await act(async () => {
      await reviewerPress("prove-again", event("Provider quota blocked the probe."));
    });
    expect(stub.callsOf("reviewer_capability_probe")).toEqual([
      { cmd: "reviewer_capability_probe", args: { provider: "claude" } },
    ]);
    expect(useToasts.getState().recent[0].title).toBe("Claude can review your cards again");
  });

  it("Prove it again that fails again says so, with the way to Diagnostics", async () => {
    const stub = tauri();
    stub.allowUnhandled();
    stub.fixture("reviewer_capability_probe", { eligible: false, proof: "quota" });
    await act(async () => {
      await reviewerPress("prove-again", event("Provider quota blocked the probe."));
    });
    const said = useToasts.getState().toasts[0];
    expect(said.title).toBe("Claude still can't review your cards");
    expect(said.details).toBe("quota");
    expect(said.action?.label).toBe("Open Diagnostics");
  });
});
