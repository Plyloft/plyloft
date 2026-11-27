// SL-6 — Build with both, as the owner meets it on the card: the offer beside
// Start build (and why it's off), the two builds with their own Build done,
// the Challenger's comparison, the pick (which then runs the normal Build
// done), a lane held by its setup, and stopping.
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import { CardDetailPanel } from "../components/CardDetailPanel";
import { readFileSync } from "node:fs";
import type { BuildBoth, BuildLane, DoctorReport, KanbanCard, LaneDiff, ToolStatus } from "../ipc";
import type { Workspace } from "../store/workspaceStore";
import { useBuilder } from "../store/builderStore";
import { useDoctor } from "../store/doctorStore";
import { useAccount } from "../store/accountStore";
import { FREE_GATES, setPlanGates } from "./planGates";
import { DEFAULT_SETTINGS, useSettings } from "../store/settingsStore";
import { useUi } from "../store/uiStore";
import { BOARD_WS, boardCard, seedBoard } from "./boardFixtures";
import { act } from "@testing-library/react";
import { laneKey } from "../lib/buildBoth";
import { useSettingUp } from "../lib/autoSetUp";
import { useBuildBoth } from "../store/buildBothStore";
import { nextFrame, renderUi, screen, waitFor, within } from "./render";

vi.mock("../components/BuilderSession", () => ({
  BuilderSession: ({ cardId }: { cardId: string }) => {
    useEffect(() => {}, []);
    return <div data-testid={`terminal-${cardId}`} />;
  },
}));
vi.mock("../components/OutcomeScreen", () => ({
  OutcomeScreen: () => <div data-testid="outcome" />,
}));

function open(card: KanbanCard, workspace: Partial<Workspace> = {}, fixtures: Record<string, unknown> = {}) {
  seedBoard([card], workspace);
  useUi.setState({ selectedCardId: { [BOARD_WS]: card.id }, centerMode: { [BOARD_WS]: "board" } });
  useBuilder.setState({ byCard: {}, vendorPref: {} });
  const view = renderUi(<CardDetailPanel workspaceId={BOARD_WS} />, {
    withToasts: true,
    fixtures: {
      card_overlap_check: [],
      reviewer_list: [],
      verify_status: null,
      verify_list_inflight: [],
      improvement_proposal_state: null,
      improvement_proposal_trust_stopped: null,
      ship_pending_release: { release: null, unreadable: null },
      card_review_tip: null,
      worktree_env_proposal: [],
      kanban_load: () => [card],
      ...fixtures,
    },
  });
  view.tauri.allowUnhandled();
  return view;
}

const tool = (id: string, found: boolean): ToolStatus => ({
  id: id as ToolStatus["id"],
  name: id,
  required: false,
  found,
  path: found ? `/bin/${id}` : null,
  version: found ? "1.0.0" : null,
  versionOk: found,
  detail: "",
  installCmd: "",
  docsUrl: "",
  reviewer: null,
});
const report = (codex: boolean): DoctorReport => ({
  tools: [tool("git", true), tool("claude", true), tool("codex", codex)],
  teamSkills: null,
  projectSkills: null,
  microphone: null,
  whisperModel: null,
  dictationShell: null,
  sharedDefinition: null,
  probeError: null,
  allRequiredOk: true,
  aiReady: true,
});

const runSection = () => document.querySelector<HTMLElement>('[data-ply-card-section="run"]')!;
/** SP-3: the two builds' cards and the comparison, under Now. */
const builds = () => document.querySelector<HTMLElement>("[data-ply-build-both-compare]")!;

function lane(id: "a" | "b", extra: Partial<BuildLane> = {}): BuildLane {
  return {
    lane: id,
    vendor: id === "a" ? "claude" : "codex",
    worktreePath: `/tmp/wt/c1${id === "b" ? "-b" : ""}`,
    branchName: `atelier/card-c1-x${id === "b" ? "-b" : ""}`,
    ...extra,
  };
}

function bothCard(bb: Partial<BuildBoth>, a: Partial<BuildLane> = {}, b: Partial<BuildLane> = {}): KanbanCard {
  return boardCard("c1", {
    notes: "Add dark mode",
    columnId: "in_progress",
    worktreePath: "/tmp/wt/c1",
    branchName: "atelier/card-c1-x",
    lastRunStatus: "running",
    buildBoth: { startedAt: 1, lanes: [lane("a", a), lane("b", b)], ...bb },
  });
}

const finished = { startedAt: 2, ptyId: null, done: { sha: "s", at: 3 }, verify: { status: "passed", sha: "s", summary: "all 2 step(s) passed", at: 4 } };

describe("1.174.3: Resume of one build", () => {
  it("marks that build's session, under its lane key", async () => {
    const before = bothCard({}, { ptyId: null });
    const { tauri } = open(before, {}, { build_both_lane_resume: () => bothCard({}, { ptyId: "pty-a" }) });
    await useBuildBoth.getState().resume(BOARD_WS, "c1", "a");
    expect(tauri.callsOf("build_both_lane_resume")).toHaveLength(1);
    useBuilder.getState().attach(laneKey("c1", "a"), BOARD_WS, "pty-a", "codex");
    expect(useBuilder.getState().byCard[laneKey("c1", "a")]?.resumedAt).toEqual(expect.any(Number));
    // The other build isn't touched, and the card's own key neither.
    useBuilder.getState().attach(laneKey("c1", "b"), BOARD_WS, "pty-b", "claude");
    expect(useBuilder.getState().byCard[laneKey("c1", "b")]?.resumedAt).toBeUndefined();
    useBuilder.getState().attach("c1", BOARD_WS, "pty-a", "codex");
    expect(useBuilder.getState().byCard.c1?.resumedAt).toBeUndefined();
    act(() => useBuilder.setState({ byCard: {} }));
  });
});

describe("a start in flight, whichever button pressed it", () => {
  // Windows walk of 1.160.0 (Challenger): the run section's Start build and
  // both Build with both buttons read the store's start state, so a start
  // pressed in the Now box (or setting the repository up) can't be pressed
  // again elsewhere, and says the same words.
  const runButton = (name: RegExp) =>
    Array.from(runSection().querySelectorAll("button")).find((b) => name.test(b.textContent ?? "")) as
      | HTMLButtonElement
      | undefined;

  it("Starting…, then Setting up…, with every start button off", async () => {
    useDoctor.setState({ report: report(true) });
    const { user } = open(boardCard("c1", { notes: "Add dark mode" }));
    const now = screen.getByRole("region", { name: "Now" });
    // 1.172.0 (C1): Now's Build with both is Start build ▾'s.
    await user.click(within(now).getByRole("button", { name: "Other ways: Start build" }));
    expect((screen.getByRole("menuitem", { name: "Build with both" }) as HTMLButtonElement).disabled).toBe(false);
    await user.keyboard("{Escape}");
    expect(runButton(/^Start build$/)?.disabled).toBe(false);

    act(() => useBuilder.setState({ startBusy: { c1: true } }));
    expect(runButton(/^Starting…$/)?.disabled).toBe(true);
    expect(runButton(/^Build with both/)?.disabled).toBe(true);
    expect((within(now).getByRole("button", { name: "Other ways: Starting…" }) as HTMLButtonElement).disabled).toBe(true);

    act(() => useSettingUp.setState({ byCard: { c1: true } }));
    expect(runButton(/^Setting up…$/)?.disabled).toBe(true);
    expect(within(now).getByRole("button", { name: "Setting up…" })).toBeTruthy();

    act(() => {
      useSettingUp.setState({ byCard: {} });
      useBuilder.setState({ startBusy: {} });
    });
    expect(runButton(/^Start build$/)?.disabled).toBe(false);
  });
});

describe("Build with both on a card not built yet", () => {
  // v1.154.1 (walk F23): on a fresh Todo card the run section is closed and
  // nothing opens it, so the offer must be on the visible surface — the Now
  // box beside Start build, and the card's ⋯. No `hidden: true` here: a
  // button only in the closed run section fails these.
  const nowBox = () => screen.getByRole("region", { name: "Now" });
  // 1.172.0 (C1; CP-11, CF B4): Build with both is Start build ▾'s other way.
  const pickBoth = async (user: ReturnType<typeof open>["user"], name = "Build with both") => {
    await user.click(within(nowBox()).getByRole("button", { name: "Other ways: Start build" }));
    await user.click(screen.getByRole("menuitem", { name }));
  };

  it("(1.172.0 C1) before the build, Now has Start build ▾ and Plan it first ▾ — two presses, no third", async () => {
    useDoctor.setState({ report: report(true) });
    const { user } = open(boardCard("c1", { notes: "" }));
    const now = nowBox();
    expect(within(now).getByText("Ready to start")).toBeTruthy();
    // Every AI way in Now before the build: the primary, its ▾, one menu.
    const presses = within(now).getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent);
    expect(presses).toEqual(["Plan it first", "Start build", "Other ways: Start build"]);
    expect(within(now).queryByRole("button", { name: "Build with both" })).toBeNull();
    expect(within(now).queryByRole("button", { name: "Plan with two AIs" })).toBeNull();
    await user.click(within(now).getByRole("button", { name: "Other ways: Start build" }));
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Build with both"]);
    await user.keyboard("{Escape}");
    await user.click(within(now).getByRole("button", { name: "Plan it first" }));
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
      expect.stringMatching(/^Plan it with Claude/),
      expect.stringMatching(/^Plan with two AIs/),
    ]);
    await user.keyboard("{Escape}");
    // The ⋯ repeats neither.
    await user.click(screen.getByRole("button", { name: "More for this card" }));
    expect(screen.queryByRole("menuitem", { name: /Plan with two AIs|Build with both|Plan it with/ })).toBeNull();
  });

  it("is offered in the Now box beside Start build with both CLIs ready, and starts both", async () => {
    useDoctor.setState({ report: report(true) });
    const { user, tauri } = open(boardCard("c1", { notes: "Add dark mode" }));
    tauri.fixture("build_both_start", () => bothCard({}));
    // The run section is closed on a card never built (aria-hidden, inert).
    expect(runSection().getAttribute("aria-hidden")).toBe("true");
    // 1.172.0 (C1): no Build with both button on the page; Start build ▾ has it.
    expect(screen.queryAllByRole("button", { name: "Build with both" })).toHaveLength(0);
    const now = nowBox();
    expect(within(now).getByRole("button", { name: "Start build" })).toBeTruthy();
    await pickBoth(user);
    // CL-8: each build's model first; nothing has moved yet.
    const sheet = await screen.findByRole("dialog", { name: "Build with both" });
    expect(tauri.callsOf("build_both_start")).toHaveLength(0);
    await user.click(within(sheet).getByRole("button", { name: "Start both builds" }));
    await waitFor(() => expect(tauri.callsOf("build_both_start")).toHaveLength(1));
    expect(tauri.callsOf("build_both_start")[0].args).toEqual({
      workspaceId: BOARD_WS,
      cardId: "c1",
      bypass: false,
      models: { claude: { model: null, reasoning: null }, codex: { model: null, reasoning: null } },
    });
    expect(tauri.callsOf("builder_start")).toHaveLength(0);
  });

  it("asks each build's model first, prefilled from the Builder rows, and starts on the models chosen (CL-8)", async () => {
    useDoctor.setState({ report: report(true) });
    useSettings.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        behavior: {
          ...DEFAULT_SETTINGS.behavior,
          models: { claude: { builder: "sonnet", challenger: "haiku" }, codex: { builder: "gpt-5.5", builderReasoning: "medium" } },
        },
      },
      loaded: true,
    } as never);
    try {
      const { user, tauri } = open(boardCard("c1", { notes: "Add dark mode" }), {
        models: { claude: { builder: "opus" }, codex: { builderReasoning: "high" } },
      });
      tauri.fixture("build_both_start", () => bothCard({}));
      await pickBoth(user);
      const sheet = await screen.findByRole("dialog", { name: "Build with both" });
      const claude = within(sheet).getByRole("textbox", { name: "Build model (Claude)" }) as HTMLInputElement;
      const codex = within(sheet).getByRole("textbox", { name: "Build model (Codex)" }) as HTMLInputElement;
      const effort = within(sheet).getByRole("combobox", { name: "Build effort (Codex)" }) as HTMLSelectElement;
      expect(claude.value).toBe("opus");
      expect(codex.value).toBe("gpt-5.5");
      expect(effort.value).toBe("high");
      expect(sheet.textContent).toContain("From the Builder row: opus (this workspace)");
      expect(sheet.textContent).toContain("From the Builder row: gpt-5.5 (app default), high effort (this workspace)");
      await user.clear(claude);
      await user.type(claude, "claude-opus-5");
      expect(sheet.textContent).toContain("Changed for this card (Builder row: opus (this workspace))");
      await user.selectOptions(effort, "low");
      // 1.169.0 (A1): Claude's build has its effort too.
      const claudeEffort = within(sheet).getByRole("combobox", { name: "Build effort (Claude)" }) as HTMLSelectElement;
      expect(claudeEffort.value).toBe("");
      expect([...claudeEffort.options].map((o) => o.value)).toEqual(["", "low", "medium", "high", "xhigh", "max"]);
      await user.selectOptions(claudeEffort, "max");
      await user.click(within(sheet).getByRole("button", { name: "Start both builds" }));
      await waitFor(() => expect(tauri.callsOf("build_both_start")).toHaveLength(1));
      expect(tauri.callsOf("build_both_start")[0].args).toMatchObject({
        models: { claude: { model: "claude-opus-5", reasoning: "max" }, codex: { model: "gpt-5.5", reasoning: "low" } },
      });
    } finally {
      useSettings.setState({ settings: DEFAULT_SETTINGS } as never);
    }
  });

  it("Cancel on the model sheet starts nothing (CL-8)", async () => {
    useDoctor.setState({ report: report(true) });
    const { user, tauri } = open(boardCard("c1", { notes: "Add dark mode" }));
    await pickBoth(user);
    const sheet = await screen.findByRole("dialog", { name: "Build with both" });
    expect(sheet.textContent).toContain("From the Builder row: The tool's default");
    await user.click(within(sheet).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Build with both" })).toBeNull());
    expect(tauri.callsOf("build_both_start")).toHaveLength(0);
  });

  it("(1.172.0 C1) while both start, Now's primary says so and is off", () => {
    useDoctor.setState({ report: report(true) });
    open(boardCard("c1", { notes: "Add dark mode" }));
    act(() => useBuildBoth.setState({ busy: { c1: "start" } }));
    try {
      const primary = within(nowBox()).getByRole("button", { name: "Starting both…" }) as HTMLButtonElement;
      expect(primary.disabled).toBe(true);
    } finally {
      act(() => useBuildBoth.setState({ busy: {} }));
    }
  });

  it("(1.172.0 C1) is not in the card's ⋯ as well: Start build ▾ has it", async () => {
    useDoctor.setState({ report: report(true) });
    const { user } = open(boardCard("c1", { notes: "Add dark mode" }));
    await user.click(screen.getByRole("button", { name: "More for this card" }));
    expect(screen.queryByRole("menuitem", { name: /Build with both/ })).toBeNull();
  });

  // Every plan: on Free, Start build ▾'s item is plain "Build with both",
  // and it starts without an upgrade sheet (its model sheet comes first).
  it("on Free, Build with both carries no Pro mark and starts without an upgrade sheet", async () => {
    const before = useAccount.getState().gates;
    setPlanGates(FREE_GATES);
    try {
      useDoctor.setState({ report: report(true) });
      const { user } = open(boardCard("c1", { notes: "Add dark mode" }));
      await user.click(within(nowBox()).getByRole("button", { name: "Other ways: Start build" }));
      const item = screen.getByRole("menuitem", { name: "Build with both" });
      expect(item.getAttribute("aria-describedby")).toBeNull();
      await user.click(item);
      expect(await screen.findByRole("dialog", { name: "Build with both" })).toBeTruthy();
      expect(screen.queryByRole("dialog", { name: /part of Pro/ })).toBeNull();
    } finally {
      setPlanGates(before);
    }
  });

  it("is off in Start build ▾ when Codex isn't installed, with the reason under it", async () => {
    useDoctor.setState({ report: report(false) });
    const { user } = open(boardCard("c1", { notes: "Add dark mode" }));
    const now = nowBox();
    const reason = "Build with both needs Claude and Codex. Codex isn't installed on this Mac.";
    expect(within(now).queryByRole("button", { name: "Build with both" })).toBeNull();
    expect(within(now).queryByText(reason, { exact: false })).toBeNull();
    expect(within(now).getByRole("button", { name: "Start build" })).toBeTruthy();
    await user.click(within(now).getByRole("button", { name: "Other ways: Start build" }));
    const item = screen.getByRole("menuitem", { name: "Build with both" }) as HTMLButtonElement;
    expect(item.disabled).toBe(true);
    expect(within(item).getByText(reason)).toBeTruthy();
    expect(screen.getByRole(item.getAttribute("role")!, { description: reason })).toBe(item);
    // The run section's own panel still says it when it is opened.
    expect(within(runSection()).getByText(reason)).toBeTruthy();
  });

  it("is not in the Now box before the Doctor has read this Mac", () => {
    useDoctor.setState({ report: null });
    open(boardCard("c1", { notes: "Add dark mode" }));
    expect(within(nowBox()).queryByRole("button", { name: "Build with both" })).toBeNull();
    expect(within(nowBox()).getByRole("button", { name: "Start build" })).toBeTruthy();
  });

  it("is not in the Now box on the guided first card; the ⋯ has it, with no Pro mark on Free", async () => {
    const before = useAccount.getState().gates;
    setPlanGates(FREE_GATES);
    useDoctor.setState({ report: report(true) });
    useSettings.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        onboarding: {
          ...DEFAULT_SETTINGS.onboarding,
          firstCard: { workspaceId: BOARD_WS, cardId: "c1", startedAt: "2026-09-29T00:00:00Z", endedAt: null, outcome: null },
        },
      },
      loaded: true,
    } as never);
    try {
      const { user } = open(boardCard("c1", { notes: "Add dark mode" }));
      expect(within(nowBox()).queryByRole("button", { name: /Build with both/ })).toBeNull();
      // 1.172.0 (C1): its one way forward — no Start build ▾; the ⋯ keeps it.
      expect(within(nowBox()).queryByRole("button", { name: "Other ways: Start build" })).toBeNull();
      await user.click(screen.getByRole("button", { name: "More for this card" }));
      const item = screen.getByRole("menuitem", { name: "Build with both" });
      expect(item.getAttribute("aria-describedby")).toBeNull();
    } finally {
      setPlanGates(before);
      useSettings.setState({ settings: DEFAULT_SETTINGS } as never);
    }
  });

  it("is not offered once the card has been built", () => {
    useDoctor.setState({ report: report(true) });
    open(
      boardCard("c1", {
        notes: "Add dark mode",
        columnId: "in_progress",
        worktreePath: "/tmp/wt/c1",
        builder: { vendor: "claude", bypass: false, ptyId: null, sessionLost: false, startedAt: 1, snapshots: [] },
      } as Partial<KanbanCard>),
    );
    expect(screen.queryByRole("button", { name: "Build with both" })).toBeNull();
  });
});

describe("a card built by both", () => {
  it("shows both builds, one terminal at a time, each with its own Build done", async () => {
    useDoctor.setState({ report: report(true) });
    const card = bothCard({}, { startedAt: 2, ptyId: "pa" }, { startedAt: 2, ptyId: "pb" });
    const { user, tauri } = open(card);
    tauri.fixture("build_both_lane_done", () => card);
    expect(screen.getAllByText("Building with both").length).toBeGreaterThan(0);
    // CL-7: each build named by its vendor; no session attached here (the
    // terminals are stand-ins), so each keeps its stage's word.
    expect(within(screen.getByRole("region", { name: "Now" })).getByText("Claude · working. Codex · working.")).toBeTruthy();
    const run = runSection();
    expect(within(run).getByTestId("terminal-c1#both-a")).toBeTruthy();
    expect(within(run).getByTestId("terminal-c1#both-b")).toBeTruthy();
    const a = run.querySelector<HTMLElement>('[data-ply-build-both-lane="a"]')!;
    const b = run.querySelector<HTMLElement>('[data-ply-build-both-lane="b"]')!;
    // SP-4: the lane not shown is hidden the closed-section way — never the
    // `hidden` attribute (overridden by its own display) or display: none.
    const hiddenLane = (el: HTMLElement) => {
      const off = el.hasAttribute("data-ply-build-both-lane-hidden");
      expect(el.classList.contains("ux-both-lane--hidden")).toBe(off);
      expect(el.getAttribute("aria-hidden")).toBe(off ? "true" : null);
      expect(el.hasAttribute("inert")).toBe(off);
      expect(el.hidden).toBe(false);
      return off;
    };
    expect(hiddenLane(a)).toBe(false);
    expect(hiddenLane(b)).toBe(true);
    await user.click(within(run).getByRole("button", { name: "Codex · working", hidden: true }));
    expect(hiddenLane(a)).toBe(true);
    expect(hiddenLane(b)).toBe(false);
    // Both terminals stay mounted whichever is shown.
    expect(within(a).getByTestId("terminal-c1#both-a")).toBeTruthy();
    expect(within(b).getByTestId("terminal-c1#both-b")).toBeTruthy();
    await user.click(within(b).getByRole("button", { name: "Finish and check", hidden: true }));
    await waitFor(() => expect(tauri.callsOf("build_both_lane_done")).toHaveLength(1));
    expect(tauri.callsOf("build_both_lane_done")[0].args).toEqual({ workspaceId: BOARD_WS, cardId: "c1", lane: "b" });
    // No pick while a build is still going.
    const pick = within(builds()).getByRole("button", { name: "Pick Claude's build" }) as HTMLButtonElement;
    expect(pick.disabled).toBe(true);
  });

  // CL-11 (walk): a build whose session finished its turn said "Claude ·
  // Working" on its switch until Build done. It now says what the session
  // does, as the Now callout does.
  it("each build's switch and line say what its session is doing", async () => {
    useDoctor.setState({ report: report(true) });
    const card = bothCard({}, { startedAt: 2, ptyId: "pa" }, { startedAt: 2, ptyId: "pb" });
    open(card);
    const now = Date.now();
    act(() => {
      useBuilder.setState((s) => ({
        byCard: {
          ...s.byCard,
          [laneKey("c1", "a")]: { ptyId: "pa", vendor: "claude", startedAt: now - 120_000, lastOutputAt: now - 60_000, promptBoxIdle: true, turnIdle: true, turnIdleAt: now - 60_000 } as never,
          [laneKey("c1", "b")]: { ptyId: "pb", vendor: "codex", startedAt: now - 120_000, lastOutputAt: now - 500, promptBoxIdle: false } as never,
        },
      }));
    });
    const run = runSection();
    expect(within(run).getByRole("button", { name: "Claude · your turn", hidden: true })).toBeTruthy();
    expect(within(run).getByRole("button", { name: /^Codex · working/, hidden: true })).toBeTruthy();
    expect(within(run).queryByRole("button", { name: /Working/, hidden: true })).toBeNull();
    const a = run.querySelector<HTMLElement>('[data-ply-build-both-lane="a"]')!;
    expect(within(a).getByText("Your turn")).toBeTruthy();
  });

  it("shows the Reviewer's recommendation with its reasons, and the pick runs the normal Build done", async () => {
    useDoctor.setState({ report: report(true) });
    const card = bothCard(
      {
        compare: {
          status: "done",
          provider: "claude",
          recommended: "b",
          reasons: ["B persists the choice", "A misses the system theme"],
          excerpt: "RECOMMENDATION: B",
        },
      },
      finished,
      { ...finished, ptyId: "pb" },
    );
    const { user, tauri } = open(card);
    const picked: KanbanCard = {
      ...card,
      worktreePath: "/tmp/wt/c1-b",
      branchName: "atelier/card-c1-x-b",
      builder: { vendor: "codex", bypass: false, ptyId: "pb", sessionLost: false, startedAt: 2, snapshots: [] },
      buildBoth: { ...card.buildBoth!, outcome: { kind: "picked", lane: "b", vendor: "codex", at: 9 } },
    };
    tauri.fixture("build_both_pick", () => picked);
    tauri.fixture("kanban_load", () => [picked]);
    tauri.fixture("builder_done", () => ({
      snapshot: { n: 1, sha: "s", at: 10 },
      newSnapshot: true,
      reselected: false,
      reviewOverridden: false,
      changesRequested: false,
      snapshotVerified: false,
      reviewWaitingOn: null,
      waitingDropped: false,
      waitingStarted: null,
    }));
    tauri.fixture("verify_start", () => "verify-1");
    tauri.fixture("builder_self_check_message", () => null);
    expect(screen.getAllByText("Pick one of the two builds").length).toBeGreaterThan(0);
    const run = builds();
    // CL-11: the judge's letters are said once, its words kept.
    expect(run.querySelector("[data-ply-build-both-legend]")?.textContent?.trim()).toBe(
      "In the Reviewer's words, A is Claude's build and B is Codex's.",
    );
    expect(within(run).getByText("B persists the choice")).toBeTruthy();
    expect(within(run).getByText("The Reviewer recommends Codex's build")).toBeTruthy();
    expect(within(run).getByText("B persists the choice")).toBeTruthy();
    const pick = within(run).getByRole("button", { name: "Pick Codex's build", hidden: true }) as HTMLButtonElement;
    expect(pick.disabled).toBe(false);
    await user.click(pick);
    const sheet = await screen.findByRole("dialog", { name: "Pick Codex's build?" });
    expect(sheet.textContent).toContain("its branch atelier/card-c1-x is kept");
    await user.click(within(sheet).getByRole("button", { name: "Pick Codex's build" }));
    await waitFor(() => expect(tauri.callsOf("build_both_pick")).toHaveLength(1));
    expect(tauri.callsOf("build_both_pick")[0].args).toEqual({ workspaceId: BOARD_WS, cardId: "c1", lane: "b" });
    await waitFor(() => expect(tauri.callsOf("builder_done")).toHaveLength(1));
  });

  it("a failed comparison offers Compare again, and a pick against it says so", async () => {
    useDoctor.setState({ report: report(true) });
    const card = bothCard({ compare: { status: "failed", error: "timed out after 10 minutes" } }, finished, finished);
    const { user, tauri } = open(card);
    tauri.fixture("build_both_compare_again", () => card);
    const run = builds();
    expect(within(run).getByText("The comparison didn't finish")).toBeTruthy();
    await user.click(within(run).getByRole("button", { name: "Compare again", hidden: true }));
    await waitFor(() => expect(tauri.callsOf("build_both_compare_again")).toHaveLength(1));
  });

  it("a Codex build whose own conversation can't be found says so and offers Start fresh (walk J1)", async () => {
    useDoctor.setState({ report: report(true) });
    const card = bothCard({}, { startedAt: 2, ptyId: "pa" }, { startedAt: 2, ptyId: null, sessionLost: true, resumeFailed: true });
    const { user, tauri } = open(card);
    const fresh = bothCard({}, { startedAt: 2, ptyId: "pa" }, { startedAt: 2, ptyId: "pb2" });
    tauri.fixture("build_both_lane_start_fresh", () => fresh);
    const b = runSection().querySelector<HTMLElement>('[data-ply-build-both-lane="b"]')!;
    expect(within(b).getByText(/Couldn't find this card's Codex conversation/)).toBeTruthy();
    expect(within(b).getByRole("button", { name: "Resume", hidden: true })).toBeTruthy();
    await user.click(within(b).getByRole("button", { name: "Start fresh", hidden: true }));
    await waitFor(() => expect(tauri.callsOf("build_both_lane_start_fresh")).toHaveLength(1));
    expect(tauri.callsOf("build_both_lane_start_fresh")[0].args).toEqual({ workspaceId: BOARD_WS, cardId: "c1", lane: "b" });
    // A build whose Resume hasn't failed offers no Start fresh.
    const a = runSection().querySelector<HTMLElement>('[data-ply-build-both-lane="a"]')!;
    expect(within(a).queryByRole("button", { name: "Start fresh", hidden: true })).toBeNull();
  });

  it("a build held by its setup offers Retry for that build, then starts the builds", async () => {
    useDoctor.setState({ report: report(true) });
    const card = bothCard(
      {},
      { startedAt: 2, ptyId: "pa" },
      { worktreeSetup: { state: "failed", command: "npm ci", exitCode: 1, reason: "The setup command failed (exit code 1).", at: 1 } },
    );
    const { user, tauri } = open(card);
    const passed = bothCard({}, { startedAt: 2, ptyId: "pa" }, { worktreeSetup: { state: "done", command: "npm ci", at: 2 } });
    tauri.fixture("card_worktree_setup_retry", () => passed);
    tauri.fixture("kanban_load", () => [passed]);
    tauri.fixture("build_both_start_lanes", () => passed);
    const b = runSection().querySelector<HTMLElement>('[data-ply-build-both-lane="b"]')!;
    expect(b.getAttribute("data-ply-build-both-stage")).toBe("setup-failed");
    await user.click(within(b).getByRole("button", { name: "Retry", hidden: true }));
    await waitFor(() => expect(tauri.callsOf("build_both_start_lanes")).toHaveLength(1));
    expect(tauri.callsOf("card_worktree_setup_retry")[0].args).toEqual({
      workspaceId: BOARD_WS,
      cardId: "c1",
      allow: null,
      lane: "b",
    });
  });

  it("a build started anyway keeps saying its setup failed once it runs", () => {
    useDoctor.setState({ report: report(true) });
    open(
      bothCard(
        {},
        { startedAt: 2, ptyId: "pa" },
        { startedAt: 3, ptyId: "pb", worktreeSetup: { state: "skipped", command: "npm ci", reason: "The setup command failed (exit code 1).", at: 1 } },
      ),
    );
    const b = runSection().querySelector<HTMLElement>('[data-ply-build-both-lane="b"]')!;
    expect(b.textContent).toContain("Setup failed — started anyway");
    expect(within(b).queryByRole("button", { name: "Retry", hidden: true })).toBeNull();
  });

  it("offers Compare again once both builds are done, even when no comparison was recorded", async () => {
    useDoctor.setState({ report: report(true) });
    const card = bothCard({}, finished, finished);
    const { user, tauri } = open(card);
    tauri.fixture("build_both_compare_again", () => card);
    await user.click(within(builds()).getByRole("button", { name: "Compare again", hidden: true }));
    await waitFor(() => expect(tauri.callsOf("build_both_compare_again")).toHaveLength(1));
  });

  it("an unchanged Build done says nothing about checks that didn't start", async () => {
    useDoctor.setState({ report: report(true) });
    const card = bothCard({}, { ...finished, ptyId: "pa" }, { startedAt: 2, ptyId: "pb" });
    const { user, tauri } = open(card);
    tauri.fixture("build_both_lane_done", () => card);
    const a = runSection().querySelector<HTMLElement>('[data-ply-build-both-lane="a"]')!;
    await user.click(within(a).getByRole("button", { name: "Finish and check again", hidden: true }));
    await waitFor(() => expect(tauri.callsOf("build_both_lane_done")).toHaveLength(1));
    expect(screen.queryByText(/Its checks are running\. When both builds/)).toBeNull();
  });

  it("a Build done in a project with no checks set up says none run (round 3)", async () => {
    useDoctor.setState({ report: report(true) });
    const card = bothCard({}, { startedAt: 2, ptyId: "pa" }, { startedAt: 2, ptyId: "pb" });
    const { user, tauri } = open(card);
    const checking = bothCard({}, { startedAt: 2, ptyId: "pa", done: { sha: "a", at: 3 }, verify: { status: "running", sha: "a", at: 3 } }, { startedAt: 2, ptyId: "pb" });
    tauri.fixture("build_both_lane_done", () => checking);
    tauri.fixture("project_config_get", () => ({ targetBranch: "main", versionFiles: [], verifyPipeline: null, installScript: null }));
    const a = runSection().querySelector<HTMLElement>('[data-ply-build-both-lane="a"]')!;
    await user.click(within(a).getByRole("button", { name: "Finish and check", hidden: true }));
    await screen.findByText(/No checks are set up for this project, so there are none to run\./);
    expect(screen.queryByText(/Its checks are running/)).toBeNull();
  });

  it("Stop building with both asks first, then stops", async () => {
    useDoctor.setState({ report: report(true) });
    const card = bothCard({}, { startedAt: 2, ptyId: "pa" }, { startedAt: 2, ptyId: "pb" });
    const { user, tauri } = open(card);
    tauri.fixture("build_both_stop", () => card);
    await user.click(within(builds()).getByRole("button", { name: "Stop building with both…", hidden: true }));
    const sheet = await screen.findByRole("dialog", { name: "Stop building with both?" });
    expect(sheet.textContent).toContain("its branch is kept");
    await user.click(within(sheet).getByRole("button", { name: "Stop building with both" }));
    await waitFor(() => expect(tauri.callsOf("build_both_stop")).toHaveLength(1));
  });
});

// SP-3: the walk saw one line under Now while both built. Both builds are
// cards under Now from the start, live — with when they started, Open
// session and Build done — while the terminals stay in the session section.
describe("Build with both side by side while building (SP-3)", () => {
  const building = () => bothCard({}, { startedAt: Date.now() - 3 * 60_000, ptyId: "pa" }, { startedAt: Date.now() - 3 * 60_000, ptyId: "pb" });

  it("shows both cards under Now with the session closed, live, with Open session and Build done", () => {
    useDoctor.setState({ report: report(true) });
    open(building());
    expect(runSection().getAttribute("aria-hidden")).toBe("true");
    const section = builds();
    expect(runSection().contains(section)).toBe(false);
    expect(section.closest("[aria-hidden]")).toBeNull();
    // After the Now callout, in the page column.
    const now = screen.getByRole("region", { name: "Now" });
    expect(now.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    for (const [id, name] of [["a", "Claude"], ["b", "Codex"]] as const) {
      const card = within(section).getByRole("article", { name: `${name}'s build` });
      expect(card.getAttribute("data-ply-build-both-card")).toBe(id);
      expect(within(card).getByText("Working")).toBeTruthy();
      expect(within(card).getByText("Started 3m ago")).toBeTruthy();
      // Visible: no `hidden: true` here.
      expect(within(card).getByRole("button", { name: "Open this Builder" })).toBeTruthy();
      expect(within(card).getByRole("button", { name: "Finish and check" })).toBeTruthy();
      expect((within(card).getByRole("button", { name: `Pick ${name}'s build` }) as HTMLButtonElement).disabled).toBe(true);
    }
    // The terminals did not move.
    expect(within(runSection()).getByTestId("terminal-c1#both-a")).toBeTruthy();
    expect(within(runSection()).getByTestId("terminal-c1#both-b")).toBeTruthy();
    expect(section.querySelector("[data-testid^=terminal]")).toBeNull();
  });

  it("says what each session is doing on its card", () => {
    useDoctor.setState({ report: report(true) });
    open(building());
    const now = Date.now();
    act(() => {
      useBuilder.setState((s) => ({
        byCard: {
          ...s.byCard,
          [laneKey("c1", "b")]: { ptyId: "pb", vendor: "codex", startedAt: now - 120_000, lastOutputAt: now - 500, promptBoxIdle: false } as never,
        },
      }));
    });
    const b = within(builds()).getByRole("article", { name: "Codex's build" });
    expect(within(b).getByText(/^Working/)).toBeTruthy();
  });

  it("Open session on Codex's card opens the session on Codex's terminal", async () => {
    useDoctor.setState({ report: report(true) });
    const { user } = open(building());
    const b = within(builds()).getByRole("article", { name: "Codex's build" });
    await user.click(within(b).getByRole("button", { name: "Open this Builder" }));
    expect(runSection().getAttribute("aria-hidden")).toBeNull();
    const laneB = runSection().querySelector<HTMLElement>('[data-ply-build-both-lane="b"]')!;
    const laneA = runSection().querySelector<HTMLElement>('[data-ply-build-both-lane="a"]')!;
    expect(laneB.hasAttribute("data-ply-build-both-lane-hidden")).toBe(false);
    expect(laneA.hasAttribute("data-ply-build-both-lane-hidden")).toBe(true);
  });

  it("Build done on a card snapshots that build", async () => {
    useDoctor.setState({ report: report(true) });
    const card = building();
    const { user, tauri } = open(card);
    tauri.fixture("build_both_lane_done", () => card);
    const a = within(builds()).getByRole("article", { name: "Claude's build" });
    await user.click(within(a).getByRole("button", { name: "Finish and check" }));
    await waitFor(() => expect(tauri.callsOf("build_both_lane_done")).toHaveLength(1));
    expect(tauri.callsOf("build_both_lane_done")[0].args).toEqual({ workspaceId: BOARD_WS, cardId: "c1", lane: "a" });
  });

  it("a finished build's card has no Open session or Build done; its Pick waits for the other", () => {
    useDoctor.setState({ report: report(true) });
    open(bothCard({}, finished, { startedAt: Date.now(), ptyId: "pb" }));
    const a = within(builds()).getByRole("article", { name: "Claude's build" });
    expect(within(a).queryByRole("button", { name: "Open this Builder" })).toBeNull();
    expect(within(a).queryByRole("button", { name: "Finish and check" })).toBeNull();
    expect(within(a).queryByText(/^Started/)).toBeNull();
    expect((within(a).getByRole("button", { name: "Pick Claude's build" }) as HTMLButtonElement).disabled).toBe(true);
  });

  // Round 2 (Challenger F4): compared, Now's press goes to the Picks right
  // under it — never back to the session.
  it("once compared, Now's primary brings the two builds into view and focuses the recommended Pick", async () => {
    useDoctor.setState({ report: report(true) });
    const { user } = open(
      bothCard({ compare: { status: "done", provider: "codex", recommended: "b", reasons: ["B persists it"] } }, finished, finished),
    );
    const now = screen.getByRole("region", { name: "Now" });
    const primary = within(now).getByRole("button", { name: "See the two builds" });
    expect(primary.getAttribute("data-ply-primary-action-id")).toBe("show-builds");
    // The page focuses its state headline a frame after it opens; under load
    // that frame could land after the press and take the focus back. Let it
    // land first, so the press's focus is the last word.
    await nextFrame();
    await user.click(primary);
    expect(document.activeElement?.getAttribute("data-ply-build-both-pick")).toBe("b");
    expect(builds().contains(document.activeElement)).toBe(true);
    expect(runSection().getAttribute("aria-hidden")).toBe("true");
  });

  it("while both still build, Now's primary keeps opening the session", () => {
    useDoctor.setState({ report: report(true) });
    open(building());
    const now = screen.getByRole("region", { name: "Now" });
    expect(within(now).queryByRole("button", { name: "See the two builds" })).toBeNull();
    expect(now.querySelector("[data-ply-primary-action-id]")?.getAttribute("data-ply-primary-action-id")).toBe("inspect-run");
  });

  it("keeps the 520 px container rule: the grid under Now is in its container", () => {
    useDoctor.setState({ report: report(true) });
    open(building());
    const grid = builds().querySelector<HTMLElement>("[data-ply-build-both-cards]")!;
    expect(grid.classList.contains("ux-both-cards")).toBe(true);
    expect(grid.parentElement!.classList.contains("ux-both-builds")).toBe(true);
  });
});

describe("the two builds side by side (CL-8)", () => {
  const diffOf = (lane: "a" | "b"): LaneDiff => ({
    lane,
    sha: "s",
    base: "base",
    added: lane === "a" ? 12 : 30,
    removed: lane === "a" ? 3 : 1,
    files:
      lane === "a"
        ? [
            { path: "src/theme.ts", kind: "modified", hunks: [{ header: "@@ -1,1 +1,2 @@", oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, body: "-a\n+b\n+c\n" }], added: 2, removed: 1 },
            { path: "src/theme.test.ts", kind: "added", hunks: [], added: 10, removed: 2 },
          ]
        : [{ path: "src/settings.ts", kind: "modified", hunks: [], added: 30, removed: 1 }],
  });
  const judged = () =>
    bothCard(
      {
        compare: {
          status: "done",
          provider: "codex",
          recommended: "b",
          reasons: ["B persists the choice"],
          lanes: [
            { lane: "a", summary: "Adds the toggle; the choice is lost on restart.", findings: ["settings.ts never saves the theme"] },
            { lane: "b", summary: "Adds the toggle and saves it.", findings: [] },
          ],
        },
      },
      { ...finished, model: "opus" },
      { ...finished, model: "gpt-5.5 high" },
    );

  it("shows a card per build with its state, changes, checks, the Reviewer's verdict and its own Pick; the judge is named", async () => {
    useDoctor.setState({ report: report(true) });
    const { tauri } = open(judged(), {}, { build_both_lane_diff: (args: { lane: "a" | "b" }) => diffOf(args.lane) });
    const run = builds();
    expect(within(run).getByText("Judged by Codex")).toBeTruthy();
    expect(within(run).getByText("The Reviewer recommends Codex's build")).toBeTruthy();
    const cards = run.querySelector<HTMLElement>("[data-ply-build-both-cards]")!;
    expect(cards.classList.contains("ux-both-cards")).toBe(true);
    expect(cards.parentElement!.classList.contains("ux-both-builds")).toBe(true);
    const a = cards.querySelector<HTMLElement>('[data-ply-build-both-card="a"]')!;
    const b = cards.querySelector<HTMLElement>('[data-ply-build-both-card="b"]')!;
    expect(a.getAttribute("aria-label")).toBe("Claude's build");
    expect(a.textContent).toContain("Done · checks passed");
    expect(a.textContent).toContain("on opus");
    expect(b.textContent).toContain("on gpt-5.5 with high effort");
    await waitFor(() => expect(within(a).getByText("2 files changed · +12 −3")).toBeTruthy());
    await waitFor(() => expect(within(b).getByText("1 file changed · +30 −1")).toBeTruthy());
    expect(tauri.callsOf("build_both_lane_diff").map((c) => c.args)).toEqual(
      expect.arrayContaining([
        { workspaceId: BOARD_WS, cardId: "c1", lane: "a" },
        { workspaceId: BOARD_WS, cardId: "c1", lane: "b" },
      ]),
    );
    expect(within(a).getByText("Its checks passed.")).toBeTruthy();
    expect(within(a).getByText("Adds the toggle; the choice is lost on restart.")).toBeTruthy();
    expect(within(a).getByText("The Reviewer's finding")).toBeTruthy();
    expect(within(a).getByText("settings.ts never saves the theme")).toBeTruthy();
    expect(within(b).getByText("The Reviewer found no problems in it.")).toBeTruthy();
    // Pick under each card; the recommended one is the strong one.
    const pickA = within(a).getByRole("button", { name: "Pick Claude's build", hidden: true });
    const pickB = within(b).getByRole("button", { name: "Pick Codex's build", hidden: true });
    expect(pickA.className).not.toBe(pickB.className);
    expect(b.hasAttribute("data-ply-build-both-recommended")).toBe(true);
    expect(a.hasAttribute("data-ply-build-both-recommended")).toBe(false);
    expect(within(b).getByText("Recommended")).toBeTruthy();
    expect(within(a).queryByText("Recommended")).toBeNull();
  });

  it("See the changes shows that build's changes, read only", async () => {
    useDoctor.setState({ report: report(true) });
    const { user } = open(judged(), {}, { build_both_lane_diff: (args: { lane: "a" | "b" }) => diffOf(args.lane) });
    const a = builds().querySelector<HTMLElement>('[data-ply-build-both-card="a"]')!;
    const openA = within(a).getByRole("button", { name: "See the changes", hidden: true }) as HTMLButtonElement;
    await waitFor(() => expect(openA.disabled).toBe(false));
    await user.click(openA);
    const sheet = await screen.findByRole("dialog", { name: "Claude's build — its changes" });
    expect(within(sheet).getByText("src/theme.ts")).toBeTruthy();
    expect(within(sheet).getByText("src/theme.test.ts")).toBeTruthy();
    expect(within(sheet).queryByRole("button", { name: "Accept" })).toBeNull();
    await user.click(within(sheet).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Claude's build — its changes" })).toBeNull());
  });

  it("a comparison from before CL-8 keeps its reasons and shows no findings per build", () => {
    useDoctor.setState({ report: report(true) });
    open(
      bothCard({ compare: { status: "done", provider: "claude", recommended: "a", reasons: ["A is smaller"] } }, finished, finished),
      {},
      { build_both_lane_diff: (args: { lane: "a" | "b" }) => diffOf(args.lane) },
    );
    const run = builds();
    expect(within(run).getByText("A is smaller")).toBeTruthy();
    expect(within(run).getByText("Judged by Claude")).toBeTruthy();
    expect(run.querySelector("[data-ply-build-both-findings]")).toBeNull();
    expect(within(run).getAllByRole("button", { name: /^Pick .*'s build$/, hidden: true })).toHaveLength(2);
  });

  it("a build without a Build done has no changes or diff yet, and no judge is named before a pass", () => {
    useDoctor.setState({ report: report(true) });
    const { tauri } = open(bothCard({}, { startedAt: 2, ptyId: "pa" }, { startedAt: 2, ptyId: "pb" }));
    const run = builds();
    expect(run.querySelector("[data-ply-build-both-changes]")).toBeNull();
    expect(within(run).queryByRole("button", { name: "See the changes", hidden: true })).toBeNull();
    expect(run.querySelector("[data-ply-build-both-judge]")).toBeNull();
    expect(tauri.callsOf("build_both_lane_diff")).toHaveLength(0);
  });

  it("hides the lane not shown as a closed section does: no room, laid out, invisible — never display: none", () => {
    const css = readFileSync("src/components/ux/ux.css", "utf8");
    const rules = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "");
    const block = rules(css.slice(css.indexOf("/* SP-4: Build with both's two sessions"), css.indexOf("/* CL-8: Build with both")));
    expect(block).toMatch(/\.ux-both-lane--hidden\s*\{[^}]*height:\s*0;[^}]*overflow:\s*hidden/);
    expect(block).toMatch(
      /\.ux-both-lane--hidden > \.ux-both-lane-body\s*\{[^}]*position:\s*absolute;[^}]*left:\s*0;[^}]*right:\s*0;[^}]*visibility:\s*hidden;[^}]*pointer-events:\s*none/,
    );
    expect(block).not.toMatch(/display:\s*none/);
    expect(rules(css)).not.toMatch(/\.ux-both-lane[^{]*\{[^}]*display:\s*none/);
  });

  it("stacks the two cards when the card column is narrow — by the column, not the window", () => {
    const css = readFileSync("src/components/ux/ux.css", "utf8");
    const block = css.slice(css.indexOf("/* CL-8: Build with both"), css.indexOf(".ux-both-card {"));
    expect(block).toMatch(/\.ux-both-builds\s*\{[^}]*container-type:\s*inline-size/);
    expect(block).toMatch(/\.ux-both-cards\s*\{[^}]*grid-template-columns:\s*repeat\(2/);
    expect(block).toMatch(/@container \(max-width: 520px\)\s*\{\s*\.ux-both-cards\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\)/);
    expect(block).not.toMatch(/@media/);
  });
});

describe("the two builds side by side, round 2 (CL-8)", () => {
  it("a single result without a pass says Only result, with the strong Pick", () => {
    useDoctor.setState({ report: report(true) });
    open(
      bothCard(
        { compare: { status: "decided", recommended: "a", reasons: ["Only Claude's build has a result; Codex's ended without one: stopped."] } },
        finished,
        { startedAt: 2, failed: "You stopped it before it finished" },
      ),
      {},
      { build_both_lane_diff: () => ({ lane: "a", sha: "s", base: "b", files: [], added: 0, removed: 0 }) },
    );
    const a = builds().querySelector<HTMLElement>('[data-ply-build-both-card="a"]')!;
    expect(within(a).getByText("Only result")).toBeTruthy();
    expect(within(a).queryByText("Recommended")).toBeNull();
    expect(a.hasAttribute("data-ply-build-both-recommended")).toBe(true);
  });

  it("a diff that can't be read says so on the card, with why behind Details", async () => {
    useDoctor.setState({ report: report(true) });
    // Diffs are read once per snapshot in this window: a sha of its own.
    open(bothCard({}, { ...finished, done: { sha: "unreadable", at: 3 } }, { startedAt: 2, ptyId: "pb" }), {}, {
      build_both_lane_diff: () => {
        throw new Error("fatal: bad object s");
      },
    });
    const a = builds().querySelector<HTMLElement>('[data-ply-build-both-card="a"]')!;
    await waitFor(() => expect(within(a).getByText("Its changes couldn't be read.")).toBeTruthy());
    expect(within(a).getByText("What went wrong")).toBeTruthy();
    expect(a.textContent).toContain("fatal: bad object s");
  });

  it("a diff cut at 4 MiB says so in its sheet", async () => {
    useDoctor.setState({ report: report(true) });
    const { user } = open(bothCard({}, { ...finished, done: { sha: "long", at: 3 } }, { startedAt: 2, ptyId: "pb" }), {}, {
      build_both_lane_diff: () => ({
        lane: "a",
        sha: "s",
        base: "b",
        cut: true,
        added: 9,
        removed: 0,
        files: [{ path: "big.txt", kind: "added", hunks: [], added: 9, removed: 0, cut: true }],
      }),
    });
    const a = builds().querySelector<HTMLElement>('[data-ply-build-both-card="a"]')!;
    const openA = within(a).getByRole("button", { name: "See the changes", hidden: true }) as HTMLButtonElement;
    await waitFor(() => expect(openA.disabled).toBe(false));
    await user.click(openA);
    const sheet = await screen.findByRole("dialog", { name: "Claude's build — its changes" });
    expect(sheet.textContent).toContain("longer than 4 MiB, so big.txt shows no lines here");
  });
});
