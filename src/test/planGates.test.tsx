// Launch G3: the plan gates as the window shows them. Everything for one
// person runs on every plan; only team features have a gate. The backend
// decides (`plan_gates_get`, the Team refusals' leads); the window says a
// Team refusal in a toast that leads to the plan, and offers Pro nowhere.
import { describe, expect, it } from "vitest";
import { within } from "@testing-library/react";
import { TeamMark } from "../components/ProMark";
import { ProposalBlock } from "../components/library/ProposalBlock";
import { ReleaseSheet } from "../components/ReleaseSheet";
import { relScope, releaseFixtures } from "./releaseFixtures";
import { KanbanBoard } from "../components/KanbanBoard";
import {
  SIGNED_OUT_LEAD,
  TEAM_ELSEWHERE_LEAD,
  TEAM_TO_CHOOSE_LEAD,
  TEAM_OTHER_ACCOUNT_LEAD,
  TEAM_OTHER_REPO_LEAD,
  TEAM_PLAN_LEAD,
  planRefusal,
  teamAllowed,
} from "../lib/planGates";
import type { ProposalView } from "../lib/proposals";
import { startPlanGates, useAccount } from "../store/accountStore";
import { useBuildBoth } from "../store/buildBothStore";
import { useBuilder } from "../store/builderStore";
import { useKanban } from "../store/kanbanStore";
import { useUi } from "../store/uiStore";
import { useWorkspaces } from "../store/workspaceStore";
import { showPlanRefusal } from "../store/planPrompts";
import { useToasts } from "../store/toastStore";
import { BOARD_WS, boardCard, seedBoard } from "./boardFixtures";
import { FREE_GATES, PRO_GATES, SIGNED_OUT_GATES, TEAM_ELSEWHERE_GATES, TEAM_GATES, setPlanGates } from "./planGates";
import { act, renderUi, screen, tauri, waitFor } from "./render";

const TEAM_REFUSAL = FREE_GATES.teamRefusal!;

/** Every toast said so far, wherever it is now. */
function said() {
  const s = useToasts.getState();
  return [...s.toasts, ...s.queue];
}

/** No sheet, mark or button anywhere offers Pro. */
function expectNoPro() {
  expect(screen.queryByRole("dialog", { name: /part of Pro/ })).toBeNull();
  expect(screen.queryByRole("button", { name: /Get Pro/ })).toBeNull();
  expect(screen.queryByRole("button", { name: "Part of Pro" })).toBeNull();
  for (const mark of document.querySelectorAll("[data-ply-pro-mark]")) expect(mark.textContent).not.toBe("Pro");
}

describe("the plan refusals are told apart by their leads", () => {
  it("names each Team code and the plan that lifts it, inside a wrapper's words too", () => {
    expect(planRefusal(new Error(`ship worker failed: ${TEAM_REFUSAL}`))).toEqual({
      code: "team_plan_required",
      requiredPlan: "team",
      message: TEAM_REFUSAL,
    });
    expect(planRefusal(`${TEAM_PLAN_LEAD} x`)?.code).toBe("team_plan_required");
    expect(planRefusal(`${TEAM_OTHER_REPO_LEAD} x`)).toMatchObject({ code: "team_other_repo", requiredPlan: "team" });
    expect(planRefusal({ message: `${TEAM_OTHER_ACCOUNT_LEAD} x` })).toMatchObject({
      code: "team_account_mismatch",
      requiredPlan: null,
    });
    expect(planRefusal("Assign yourself the GitHub issue first (use the Claim button).")).toBeNull();
  });

  it("1.178.0 (A3 D18, D19): signed out, and Team on another computer, have codes of their own", () => {
    const signedOut = SIGNED_OUT_GATES.teamRefusal!;
    expect(signedOut.startsWith(SIGNED_OUT_LEAD)).toBe(true);
    expect(planRefusal(new Error(`claim failed: ${signedOut}`))).toEqual({
      code: "sign_in_required",
      requiredPlan: "team",
      message: signedOut,
    });
    const elsewhere = TEAM_ELSEWHERE_GATES.teamRefusal!;
    expect(elsewhere.startsWith(TEAM_ELSEWHERE_LEAD)).toBe(true);
    expect(planRefusal({ message: elsewhere })).toEqual({ code: "team_elsewhere", requiredPlan: null, message: elsewhere });
    const toChoose = "Choose a computer to use Team.";
    expect(toChoose.startsWith(TEAM_TO_CHOOSE_LEAD)).toBe(true);
    expect(planRefusal({ message: toChoose })).toEqual({ code: "team_to_choose", requiredPlan: null, message: toChoose });
    // D18 names a Team plan, but its lead is the account's, not "Team plan needed:".
    expect(planRefusal(signedOut)?.code).not.toBe("team_plan_required");
    expect([SIGNED_OUT_GATES, TEAM_ELSEWHERE_GATES].map(teamAllowed)).toEqual([false, false]);
  });

  it("the old Pro and card-slot leads are no plan refusal any more", () => {
    // What an older backend said: an ordinary error now, never a plan sheet.
    expect(planRefusal("Pro plan needed: Ship batch is part of Pro.")).toBeNull();
    expect(planRefusal("Free plan: one card builds at a time. “Fix login” is still active.")).toBeNull();
  });

  it("reads the backend's Team decision, locked before the first read", () => {
    expect(teamAllowed(null)).toBe(false);
    expect([FREE_GATES, PRO_GATES, TEAM_GATES].map(teamAllowed)).toEqual([false, false, true]);
  });

  it("reads the gates at start and again when the account changes", async () => {
    const stub = tauri();
    let answer = FREE_GATES;
    stub.fixture("plan_gates_get", () => answer);
    startPlanGates();
    await waitFor(() => expect(useAccount.getState().gates).toEqual(FREE_GATES));
    answer = TEAM_GATES;
    act(() => stub.emit("account://changed", { signedIn: true }));
    await waitFor(() => expect(useAccount.getState().gates).toEqual(TEAM_GATES));
  });
});

describe("a Team refusal is said in a toast that leads to the plan", () => {
  it("Team plan needed: See your plan opens Settings › Plan", async () => {
    renderUi(<div />);
    expect(showPlanRefusal(new Error(`promote failed: ${TEAM_REFUSAL}`))).toBe(true);
    const toast = said().find((t) => t.title === TEAM_REFUSAL);
    expect(toast?.kind).toBe("warn");
    expect(toast?.action?.label).toBe("See your plan");
    act(() => toast!.action!.onClick());
    expect(useUi.getState().settingsOverlayOpen).toBe(true);
    expect(useUi.getState().settingsSection).toBe("plan");
    expectNoPro();
  });

  it("signed out (D18): the Team refusal's toast, See your plan opens Settings › Plan", () => {
    renderUi(<div />);
    const message = SIGNED_OUT_GATES.teamRefusal!;
    expect(showPlanRefusal(new Error(`promote failed: ${message}`))).toBe(true);
    const toast = said().find((t) => t.title === message);
    expect(toast?.kind).toBe("warn");
    expect(toast?.action?.label).toBe("See your plan");
    act(() => toast!.action!.onClick());
    expect(useUi.getState().settingsSection).toBe("plan");
  });

  it("Team on another computer (D19): See your plan too", () => {
    renderUi(<div />);
    const message = TEAM_ELSEWHERE_GATES.teamRefusal!;
    expect(showPlanRefusal(message)).toBe(true);
    const toast = said().find((t) => t.title === message);
    expect(toast?.kind).toBe("warn");
    expect(toast?.action?.label).toBe("See your plan");
    act(() => toast!.action!.onClick());
    expect(useUi.getState().settingsSection).toBe("plan");
  });

  it("Team ready on no computer yet: See your plan too", () => {
    renderUi(<div />);
    const message = "Choose a computer to use Team.";
    expect(showPlanRefusal(message)).toBe(true);
    const toast = said().find((t) => t.title === message);
    expect(toast?.action?.label).toBe("See your plan");
  });

  it("another team's plan: See your plan too", () => {
    const message = `${TEAM_OTHER_REPO_LEAD} it is for acme/team.`;
    expect(showPlanRefusal(message)).toBe(true);
    expect(said().find((t) => t.title === message)?.action?.label).toBe("See your plan");
  });

  it("another account: Switch account opens Settings › Plan", () => {
    const message = `${TEAM_OTHER_ACCOUNT_LEAD} the team is octocat's.`;
    expect(showPlanRefusal({ message })).toBe(true);
    const toast = said().find((t) => t.title === message);
    expect(toast?.action?.label).toBe("Switch account");
    act(() => toast!.action!.onClick());
    expect(useUi.getState().settingsSection).toBe("plan");
  });

  it("any other error is the caller's to say", () => {
    const before = said().length;
    expect(showPlanRefusal(new Error("git fetch failed"))).toBe(false);
    expect(showPlanRefusal("Pro plan needed: Ship batch is part of Pro.")).toBe(false);
    expect(said()).toHaveLength(before);
  });

  it("the Team mark shows without the Team plan, never before the first read", () => {
    setPlanGates(null);
    const r = renderUi(<TeamMark />);
    expect(document.querySelector("[data-ply-pro-mark]")).toBeNull();
    act(() => setPlanGates(FREE_GATES));
    expect(document.querySelector("[data-ply-pro-mark]")?.textContent).toBe("Team");
    act(() => setPlanGates(TEAM_GATES));
    expect(document.querySelector("[data-ply-pro-mark]")).toBeNull();
    r.unmount();
  });
});

describe("nothing for one person needs a plan, and nothing offers Pro", () => {
  it("Build with both on Free does what it does on Team; no sheet, no checkout", async () => {
    seedBoard([boardCard("c1", { columnId: "todo" })]);
    renderUi(<div />);
    setPlanGates(TEAM_GATES);
    await act(() => useBuildBoth.getState().start(BOARD_WS, "c1"));
    const onTeam = useBuildBoth.getState().choosing;
    act(() => useBuildBoth.getState().cancelStart());
    setPlanGates(FREE_GATES);
    await act(() => useBuildBoth.getState().start(BOARD_WS, "c1"));
    expect(useBuildBoth.getState().choosing).toEqual(onTeam);
    expectNoPro();
    expect(tauri().callsOf("account_checkout")).toHaveLength(0);
  });

  // 1.174.0 D1(b): what is on main is released on every plan; now any number
  // of ready cards goes with it, on Free too.
  it("on Free the Release sheet takes two ready cards with no Pro mark or sheet", async () => {
    setPlanGates(FREE_GATES);
    useWorkspaces.setState({ workspaces: [{ id: "ws-1", name: "lyra", cwd: "/tmp/ply-test" }] as never, activeId: "ws-1" });
    useKanban.setState({
      byWorkspace: {
        "ws-1": {
          cards: [
            { id: "r1", workspaceId: "ws-1", title: "Blog: RSS feed for posts", columnId: "complete", verifyStatus: "passed", shipStatus: "unshipped", createdAt: 1, updatedAt: 1 },
            { id: "r2", workspaceId: "ws-1", title: "Search: index the glossary", columnId: "complete", verifyStatus: "passed", shipStatus: "unshipped", createdAt: 1, updatedAt: 1 },
          ],
          loaded: true,
        },
      },
    } as never);
    function Host() {
      const ask = useUi((s) => s.releaseSheet);
      return ask ? <ReleaseSheet ask={ask} onClose={() => useUi.getState().setReleaseSheet(null)} /> : null;
    }
    renderUi(<Host />, { fixtures: releaseFixtures(relScope({ readyCardIds: ["r1", "r2"] })) });
    act(() => useUi.getState().setReleaseSheet({ workspaceId: "ws-1", areaId: null }));
    const sheet = await screen.findByRole("dialog", { name: "Release lyra" });
    expect(await within(sheet).findByText(/Search: index the glossary/)).toBeTruthy();
    expectNoPro();
  });

  it("Approve on a skill improvement approves on Free, unmarked", async () => {
    setPlanGates(FREE_GATES);
    let approved = 0;
    const view: ProposalView = {
      target: { kind: "instructions", file: "AGENTS.md" },
      label: "AGENTS.md",
      scope: "repository",
      path: "AGENTS.md",
      cardId: "c-1",
      cardRef: "#88",
      reason: "The Builder reported done twice before running the tests.",
      words: "Add one line: run the tests before saying done.",
      diff: null,
      createdAt: Date.now() - 3600_000,
      canApprove: true,
      commitTo: null,
    } as unknown as ProposalView;
    const { user } = renderUi(
      <ProposalBlock view={view} busy={false} onApprove={() => (approved += 1)} onDismiss={() => {}} nowMs={Date.now()} />,
    );
    await user.click(screen.getByRole("button", { name: "Approve and publish" }));
    expect(approved).toBe(1);
    expectNoPro();
  });

  it("a second card starts on Free while another builds: no slot, no sheet", async () => {
    setPlanGates(FREE_GATES);
    const busy = boardCard("busy", { columnId: "in_progress", title: "Fix login", worktreePath: "/wt/busy" });
    const c2 = boardCard("c2", { columnId: "todo", title: "Add search" });
    seedBoard([busy, c2]);
    const stub = tauri();
    stub.fixture("worktree_env_proposal", []);
    stub.fixture("kanban_card_advance_to_in_progress", () => ({
      ...boardCard("c2", { columnId: "in_progress", title: "Add search" }),
      worktreePath: "/wt/c2",
    }));
    stub.allowUnhandled();
    renderUi(<div />);
    await act(() => useKanban.getState().moveCard("c2", "in_progress"));
    expect(stub.callsOf("kanban_card_advance_to_in_progress")).toHaveLength(1);
    expect(screen.queryByRole("dialog", { name: "One card at a time on Free" })).toBeNull();
    expect(stub.callsOf("plan_card_slot")).toHaveLength(0);
    expect(stub.callsOf("kanban_card_put_back")).toHaveLength(0);
    expectNoPro();
  });

  it("new work on a shipped card goes to its Builder on Free, with no slot asked", async () => {
    setPlanGates(FREE_GATES);
    seedBoard([boardCard("s1", { columnId: "complete", reviewStatus: "merged" })]);
    const stub = tauri();
    stub.allowUnhandled();
    renderUi(<div />);
    await act(() => useBuilder.getState().acceptPushback(BOARD_WS, "s1").catch(() => {}));
    expect(stub.callsOf("plan_claim_back_at_work")).toHaveLength(0);
    expect(stub.callsOf("builder_accept_pushback")).toHaveLength(1);
    expect(screen.queryByRole("dialog", { name: "One card at a time on Free" })).toBeNull();
    act(() => useBuilder.getState().clearError("s1"));
  });

  it("the Board's header on Free names no plan and reads no card slot", async () => {
    setPlanGates(FREE_GATES);
    seedBoard([boardCard("busy", { columnId: "in_progress", title: "Fix login" })]);
    const stub = tauri();
    stub.allowUnhandled();
    renderUi(<KanbanBoard workspaceId={BOARD_WS} />);
    await new Promise((r) => setTimeout(r, 400));
    expect(document.querySelector("[data-ply-board-free-slot]")).toBeNull();
    expect(stub.callsOf("plan_card_slot")).toHaveLength(0);
    expect(document.body.textContent).not.toContain("Free plan");
    expectNoPro();
  });
});

describe("Retry on a card still In progress (Reviewer P3-3)", () => {
  it("runs again in place, never through To do", async () => {
    setPlanGates(FREE_GATES);
    seedBoard([
      boardCard("r1", {
        columnId: "in_progress",
        worktreePath: "/w/r1",
        agentConfigId: "agent-x",
        lastRunStatus: "failed",
      }),
    ]);
    const stub = tauri();
    stub.allowUnhandled();
    stub.fixture("card_compose_dispatch_prompt", "do it");
    await act(() => useKanban.getState().moveCard("r1", "in_progress", { redispatch: true }));
    expect(stub.callsOf("kanban_card_patch")).toHaveLength(0);
    expect(stub.callsOf("kanban_card_advance_to_in_progress")).toHaveLength(0);
    expect(stub.callsOf("card_compose_dispatch_prompt")).toHaveLength(1);
    // Without the option a card already in the column is left alone, as before.
    await act(() => useKanban.getState().moveCard("r1", "in_progress"));
    expect(stub.callsOf("card_compose_dispatch_prompt")).toHaveLength(1);
  });
});
