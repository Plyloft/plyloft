// OB-16 (onboarding §14, D17): the guided first card as the person meets it —
// offered on Setup's Ready step, made as an ordinary card on the Board, the
// Guide on that card's page only (one sentence per state, a quiet End the
// guide), and the record following the card: shipped, or deleted.
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import { CardDetailPanel } from "../components/CardDetailPanel";
import { SetupOverlay } from "../components/SetupOverlay";
import type { KanbanCard } from "../ipc";
import { FIRST_CARD_BRIEF, FIRST_CARD_TITLE } from "../lib/firstCardGuide";
import type { FirstCardGuide, TutorialProgress } from "../lib/settingsShape";
import { startFirstCardGuideSubscription, startGuidedFirstCard } from "../store/firstCardGuideStore";
import { useKanban } from "../store/kanbanStore";
import { DEFAULT_SETTINGS, useSettings, type Settings } from "../store/settingsStore";
import { useSetup } from "../store/setupStore";
import { useUi } from "../store/uiStore";
import { useWorkspaces } from "../store/workspaceStore";
import { BOARD_WS, boardCard, boardWorkspace, seedBoard } from "./boardFixtures";
import { act, nextFrame, renderUi, screen, waitFor, within } from "./render";
import { useBuilder } from "../store/builderStore";
import { usePrAutoFix } from "../store/prAutoFixStore";
import { useTutorialRuntime } from "../store/tutorialStore";
import { endQuickTour, useQuickTour } from "../store/quickTourStore";

vi.mock("../components/BuilderSession", () => ({
  BuilderSession: () => <div data-testid="builder-terminal" />,
}));
vi.mock("../components/IntakeConversation", () => ({
  IntakeConversation: () => <div data-testid="intake-terminal" />,
}));
vi.mock("../components/OutcomeScreen", () => ({
  OutcomeScreen: ({
    onPresentationChange,
  }: {
    onPresentationChange?: (s: { loading: boolean; filesChanged: number | null; shipBusy: boolean }) => void;
  }) => {
    useEffect(() => {
      const t = setTimeout(() => onPresentationChange?.({ loading: false, filesChanged: 1, shipBusy: false }));
      return () => clearTimeout(t);
    }, [onPresentationChange]);
    return <div data-testid="outcome" />;
  },
}));

const guideOn = (cardId: string, patch: Partial<FirstCardGuide> = {}): FirstCardGuide => ({
  workspaceId: BOARD_WS,
  cardId,
  startedAt: "2026-09-28T10:00:00Z",
  endedAt: null,
  outcome: null,
  ...patch,
});

const withGuide = (guide: FirstCardGuide | null, behavior: Partial<Settings["behavior"]> = {}): Settings => ({
  ...DEFAULT_SETTINGS,
  behavior: { ...DEFAULT_SETTINGS.behavior, ...behavior },
  onboarding: { ...DEFAULT_SETTINGS.onboarding, firstCard: guide },
});

const savedGuide = (tauri: ReturnType<typeof renderUi>["tauri"]) => {
  const all = tauri.callsOf("settings_set").map((c) => c.args.settings as Settings);
  return all[all.length - 1]?.onboarding.firstCard ?? null;
};

function openCard(card: KanbanCard, settings: Settings, extra: KanbanCard[] = []) {
  seedBoard([card, ...extra]);
  act(() => useSettings.setState({ settings, loaded: true }));
  useUi.setState({ selectedCardId: { [BOARD_WS]: card.id }, centerMode: { [BOARD_WS]: "board" } });
  const view = renderUi(<CardDetailPanel workspaceId={BOARD_WS} />, {
    fixtures: {
      settings_set: ({ settings: next }: Record<string, unknown>) => next,
      project_config_get: { targetBranch: "master" },
      card_overlap_check: [],
      reviewer_list: [],
      verify_status: null,
      improvement_proposal_state: null,
      improvement_proposal_trust_stopped: null,
      ship_pending_release: { release: null, unreadable: null },
      card_review_tip: null,
    },
  });
  view.tauri.allowUnhandled();
  return view;
}

const guide = () => document.querySelector<HTMLElement>("[data-ply-first-card-guide]");

// 1.172.0 D2 (CP-25): the choice is under the facts line's Change….
const permissionsPick = () => {
  if (!document.querySelector("[data-ply-card-pickers]")) {
    act(() => document.querySelector<HTMLElement>("[data-ply-card-change]")?.click());
  }
  return document.querySelector<HTMLElement>("[data-ply-card-pickers] [data-ply-builder-permissions]");
};

describe("the Guide on the guided card's page", () => {
  it("Ready to start: one sentence naming the Builder, under the Now box; End the guide dismisses it", async () => {
    const card = boardCard("c1", { title: FIRST_CARD_TITLE, notes: FIRST_CARD_BRIEF });
    const { user, tauri } = openCard(card, withGuide(guideOn("c1")));
    const box = guide()!;
    expect(box.dataset.plyFirstCardGuide).toBe("ready");
    expect(box.textContent).toContain("Guide");
    expect(box.textContent).toContain("Press Start build. Claude opens in this card and starts on the task.");
    // Under the Now box, so "the box above" is.
    const nowBox = screen.getByRole("region", { name: "Now" });
    expect(nowBox.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The card is ordinary: Start build is the card's own primary.
    expect(screen.getByRole("button", { name: "Start build" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "End the guide" }));
    await waitFor(() => expect(guide()).toBeNull());
    expect(savedGuide(tauri)).toMatchObject({ cardId: "c1", outcome: "dismissed" });
    expect(savedGuide(tauri)?.endedAt).toBeTruthy();
  });

  it("names Codex when Codex builds the card", () => {
    const card = boardCard("c1", { title: FIRST_CARD_TITLE, notes: FIRST_CARD_BRIEF, builderVendorPref: "codex" });
    openCard(card, withGuide(guideOn("c1")));
    expect(guide()!.textContent).toContain("Press Start build. Codex opens in this card and starts on the task.");
  });

  it("is on that card only, and not once it has ended", () => {
    const other = boardCard("c2", { notes: "Something else." });
    openCard(other, withGuide(guideOn("c1")), [boardCard("c1", { notes: FIRST_CARD_BRIEF })]);
    expect(guide()).toBeNull();
    act(() => useUi.setState({ selectedCardId: { [BOARD_WS]: "c1" } }));
    expect(guide()).not.toBeNull();
    act(() =>
      useSettings.setState({
        settings: withGuide(guideOn("c1", { endedAt: "2026-09-28T11:00:00Z", outcome: "dismissed" })),
      }),
    );
    expect(guide()).toBeNull();
  });

  it("TU-5 (§2): not drawn while the tour runs on that card — one guide at a time; back once the tour ends", () => {
    const card = boardCard("c1", { title: FIRST_CARD_TITLE, notes: FIRST_CARD_BRIEF });
    const tour = { startedAt: "2026-10-21T09:00:00Z", path: "full" as const, workspaceId: BOARD_WS, cardId: "c1" };
    const settings = withGuide(guideOn("c1"));
    openCard(card, { ...settings, onboarding: { ...settings.onboarding, tutorial: tour } });
    expect(guide()).toBeNull();
    // The record and the permission rule are the guide's, untouched.
    expect(useSettings.getState().settings.onboarding.firstCard).toMatchObject({ cardId: "c1", endedAt: null });
    // A tour on another card leaves the callout as it is.
    act(() =>
      useSettings.setState({
        settings: { ...settings, onboarding: { ...settings.onboarding, tutorial: { ...tour, cardId: "other" } } },
      }),
    );
    expect(guide()).not.toBeNull();
    // The tour on it again, then ended: the callout comes back.
    act(() =>
      useSettings.setState({ settings: { ...settings, onboarding: { ...settings.onboarding, tutorial: tour } } }),
    );
    expect(guide()).toBeNull();
    act(() =>
      useSettings.setState({
        settings: {
          ...settings,
          onboarding: { ...settings.onboarding, tutorial: { ...tour, endedAt: "2026-10-21T10:00:00Z" } },
        },
      }),
    );
    expect(guide()).not.toBeNull();
  });

  it("stopped: the failed run's sentence; shipped: the loop, with End the guide", async () => {
    const failed = boardCard("c1", { notes: FIRST_CARD_BRIEF, lastRunStatus: "failed" });
    openCard(failed, withGuide(guideOn("c1")));
    expect(guide()!.dataset.plyFirstCardGuide).toBe("stopped");
    expect(guide()!.textContent).toContain(
      "Something stopped. The box above says what and what to do; the guide waits.",
    );
    act(() => {
      useKanban.setState({
        byWorkspace: {
          [BOARD_WS]: {
            cards: [{ ...failed, lastRunStatus: "success", shipStatus: "shipped", columnId: "complete" }],
            loaded: true,
          },
        },
      });
      useSettings.setState({ settings: withGuide(guideOn("c1", { outcome: "shipped" })) });
    });
    await waitFor(() => expect(guide()!.dataset.plyFirstCardGuide).toBe("shipped"));
    expect(guide()!.textContent).toContain("That's the whole loop: describe, build, review, ship.");
    expect(screen.getByRole("button", { name: "End the guide" })).toBeTruthy();
  });

  it("a shipped card the Board auto-archived still reads Shipped", () => {
    const landed = boardCard("c1", {
      notes: FIRST_CARD_BRIEF,
      lastRunStatus: "success",
      shipStatus: "shipped",
      archived: true,
      columnId: "complete",
    });
    openCard(landed, withGuide(guideOn("c1")));
    expect(guide()!.dataset.plyFirstCardGuide).toBe("shipped");
    expect(guide()!.textContent).toContain("That's the whole loop: describe, build, review, ship.");
  });

  it("ready to ship: names the branch Ship it merges into on this Mac", async () => {
    const built = boardCard("c1", {
      notes: FIRST_CARD_BRIEF,
      lastRunStatus: "success",
      verifyStatus: "passed",
      columnId: "in_progress",
    });
    openCard(built, withGuide(guideOn("c1")));
    await waitFor(() => expect(guide()!.dataset.plyFirstCardGuide).toBe("ship"));
    await waitFor(() =>
      expect(guide()!.textContent).toContain("Read the review opens the review of the change. Ship it merges it into master on this Mac."),
    );
  });
});

describe("the record follows the card", () => {
  it("the card deleted ends the guide; the card shipped records shipped", async () => {
    seedBoard([boardCard("c1", { notes: FIRST_CARD_BRIEF })]);
    act(() => useSettings.setState({ settings: withGuide(guideOn("c1")), loaded: true }));
    const { tauri } = renderUi(<div />, {
      fixtures: {
        settings_set: ({ settings: next }: Record<string, unknown>) => next,
        // The disk, once the card is deleted.
        kanban_load: [],
      },
    });
    startFirstCardGuideSubscription();
    await nextFrame();
    expect(tauri.callsOf("settings_set")).toHaveLength(0);

    act(() =>
      useKanban.setState({
        byWorkspace: { [BOARD_WS]: { cards: [boardCard("c1", { shipStatus: "shipped" })], loaded: true } },
      }),
    );
    await waitFor(() => expect(savedGuide(tauri)).toMatchObject({ outcome: "shipped", endedAt: null }));

    act(() => useKanban.setState({ byWorkspace: { [BOARD_WS]: { cards: [], loaded: true } } }));
    await waitFor(() => expect(savedGuide(tauri)?.endedAt).toBeTruthy());
    expect(savedGuide(tauri)?.outcome).toBe("shipped");
  });

  it("a guided card deleted before shipping is dismissed", async () => {
    seedBoard([]);
    act(() => useSettings.setState({ settings: withGuide(guideOn("c1")), loaded: true }));
    const { tauri } = renderUi(<div />, {
      fixtures: {
        settings_set: ({ settings: next }: Record<string, unknown>) => next,
        kanban_load: [],
      },
    });
    startFirstCardGuideSubscription();
    await waitFor(() => expect(savedGuide(tauri)).toMatchObject({ cardId: "c1", outcome: "dismissed" }));
  });

  it("a failed board read (an empty list) does not end the guide", async () => {
    // kanbanStore.loadFromDisk leaves `{ cards: [], loaded: true }` on a failed read.
    seedBoard([]);
    act(() => useSettings.setState({ settings: withGuide(guideOn("c1")), loaded: true }));
    const { tauri } = renderUi(<div />, {
      fixtures: {
        settings_set: ({ settings: next }: Record<string, unknown>) => next,
        kanban_load: () => Promise.reject(new Error("disk said no")),
      },
    });
    startFirstCardGuideSubscription();
    await waitFor(() => expect(tauri.callsOf("kanban_load")).toHaveLength(1));
    await nextFrame();
    // The same list again is not asked about again.
    act(() => useSettings.setState({ settings: withGuide(guideOn("c1")) }));
    await nextFrame();
    expect(tauri.callsOf("kanban_load")).toHaveLength(1);
    expect(tauri.callsOf("settings_set")).toHaveLength(0);
    // …and the subscription isn't locked by it (review 2): the card showing
    // up shipped is still recorded.
    act(() =>
      useKanban.setState({
        byWorkspace: { [BOARD_WS]: { cards: [boardCard("c1", { shipStatus: "shipped" })], loaded: true } },
      }),
    );
    await waitFor(() => expect(savedGuide(tauri)).toMatchObject({ outcome: "shipped", endedAt: null }));
  });

  it("a stale reload without the new card does not end the guide (the disk has it)", async () => {
    seedBoard([]);
    act(() => useSettings.setState({ settings: withGuide(guideOn("c1")), loaded: true }));
    const { tauri } = renderUi(<div />, {
      fixtures: {
        settings_set: ({ settings: next }: Record<string, unknown>) => next,
        kanban_load: [boardCard("c1", { notes: FIRST_CARD_BRIEF })],
      },
    });
    startFirstCardGuideSubscription();
    await waitFor(() => expect(tauri.callsOf("kanban_load")).toHaveLength(1));
    await nextFrame();
    expect(tauri.callsOf("settings_set")).toHaveLength(0);
  });
});

// ── Setup's Ready step ───────────────────────────────────────────────────

type Tool = { id: string; found: boolean; versionOk: boolean };
const tool = (id: string, found: boolean): Tool => ({ id, found, versionOk: found });

async function openReady(
  settings: Settings,
  tools: Tool[],
  more: { level?: "guided" | "fast"; fixtures?: Record<string, unknown> } = {},
) {
  act(() => {
    useSettings.setState({
      settings: {
        ...settings,
        identity: { ...settings.identity, userEmail: "me@example.com" },
        onboarding: {
          ...settings.onboarding,
          level: more.level ?? "guided",
          currentStep: "ready",
          firstRunCompletedAt: "x",
        },
      },
      loaded: true,
    });
    useWorkspaces.setState({ workspaces: [boardWorkspace], activeId: BOARD_WS, loaded: true });
    useSetup.setState({ open: true, setupCase: "existing", ...(more.level === "fast" ? { step: "ready" as const } : {}) });
  });
  const view = renderUi(<SetupOverlay />, {
    fixtures: {
      settings_set: ({ settings: next }: Record<string, unknown>) => next,
      dependency_doctor: {
        tools,
        allRequiredOk: true,
        whisperModel: { model: "small", present: false, path: null, detail: "Not downloaded." },
      },
      team_work_mode: { mode: "solo", chosen: true },
      team_status: { teamRepo: null, teamName: null, hasClone: false },
      project_config_list: [[BOARD_WS, {}]],
      project_inspect: { git: { kind: "branch", branch: "main", commit: "abc" }, branches: ["main"] },
      setup_github_status: {
        ghFound: true,
        accounts: [],
        helper: "none",
        githubEmail: null,
        githubNoreply: null,
        sso: null,
      },
      kanban_load: [],
      kanban_card_create: (args: Record<string, unknown>) => ({
        id: args.cardId,
        workspaceId: args.workspaceId,
        title: args.title,
        notes: args.notes,
        columnId: args.columnId,
        createdAt: 1,
        updatedAt: 1,
      }),
      kanban_card_set_builder_vendor_pref: (args: Record<string, unknown>) => ({
        id: args.cardId,
        workspaceId: args.workspaceId,
        title: FIRST_CARD_TITLE,
        columnId: "todo",
        builderVendorPref: args.vendor,
        createdAt: 1,
        updatedAt: 1,
      }),
      workspace_set_active: null,
      ...more.fixtures,
    },
  });
  view.tauri.allowUnhandled();
  await nextFrame();
  return view;
}

// Getting started TU-5 (TUTORIAL_SPEC §2, D6): on "I'm new to this", Ready's
// primary is Start the tour; the guided first card stays in the tour's B3.
// TU-6 (§2, D7): on "I use them regularly" Ready's quiet offer is *Take a
// 1-minute tour*; a guided card under way keeps its way back. The card
// itself is made as before (the tour's *Use a safe example* makes it).
describe("the guided first card (Setup's Ready, the tour's safe example)", () => {
  it("makes the card in Todo with the brief, records the guide and opens the card", async () => {
    const { tauri } = await openReady(
      withGuide(null),
      [tool("git", true), tool("claude", true), tool("codex", false)],
      { level: "fast" },
    );
    expect(screen.queryByRole("button", { name: "Try a guided first card" })).toBeNull();
    await act(async () => {
      await startGuidedFirstCard(BOARD_WS);
    });

    const created = tauri.callsOf("kanban_card_create");
    expect(created).toHaveLength(1);
    expect(created[0].args).toMatchObject({
      workspaceId: BOARD_WS,
      title: "Describe this project in the README",
      notes: FIRST_CARD_BRIEF,
      columnId: "todo",
    });
    const cardId = created[0].args.cardId as string;
    // The default vendor (Claude) is ready: nothing stored on the card.
    expect(tauri.callsOf("kanban_card_set_builder_vendor_pref")).toHaveLength(0);
    const all = tauri.callsOf("settings_set").map((c) => c.args.settings as Settings);
    expect(all.some((s) => s.onboarding.firstCard?.cardId === cardId && !s.onboarding.firstCard.endedAt)).toBe(true);
    expect(useUi.getState().selectedCardId[BOARD_WS]).toBe(cardId);
    expect(useUi.getState().centerMode[BOARD_WS]).toBe("board");
  });

  it("a second press while the card is being made makes no second card", async () => {
    const { tauri } = await openReady(withGuide(null), [tool("git", true), tool("claude", true)]);
    const first = startGuidedFirstCard(BOARD_WS);
    const second = startGuidedFirstCard(BOARD_WS);
    const [a, b] = await Promise.all([first, second]);
    expect(a.id).toBe(b.id);
    expect(tauri.callsOf("kanban_card_create")).toHaveLength(1);
  });

  it("the record not written: the card is deleted again and no guide is kept", async () => {
    const { tauri } = await openReady(withGuide(null), [tool("git", true), tool("claude", true)]);
    tauri.fixture("settings_set", () => Promise.reject(new Error("disk full")));
    tauri.fixture("kanban_card_delete", { worktree: null });
    await expect(startGuidedFirstCard(BOARD_WS)).rejects.toThrow("disk full");
    const created = tauri.callsOf("kanban_card_create");
    expect(created).toHaveLength(1);
    await waitFor(() => expect(tauri.callsOf("kanban_card_delete")).toHaveLength(1));
    expect(tauri.callsOf("kanban_card_delete")[0].args.cardId).toBe(created[0].args.cardId);
    expect(useKanban.getState().byWorkspace[BOARD_WS]?.cards.some((c) => c.id === created[0].args.cardId)).toBe(false);
    expect(useSettings.getState().settings.onboarding.firstCard ?? null).toBeNull();
  });

  it("with only Codex ready, the card is built by Codex", async () => {
    const { tauri } = await openReady(
      withGuide(null, { builderVendor: "claude" }),
      [tool("git", true), tool("claude", false), tool("codex", true)],
      { level: "fast" },
    );
    await act(async () => {
      await startGuidedFirstCard(BOARD_WS);
    });
    await waitFor(() => expect(tauri.callsOf("kanban_card_set_builder_vendor_pref")).toHaveLength(1));
    expect(tauri.callsOf("kanban_card_set_builder_vendor_pref")[0].args.vendor).toBe("codex");
  });

  it("a guide under way is offered as the way back to its card; a shipped one is not offered", async () => {
    const { user } = await openReady(withGuide(guideOn("c9")), [tool("git", true), tool("claude", true)], {
      level: "fast",
    });
    await user.click(await screen.findByRole("button", { name: "Open the guided first card" }));
    await waitFor(() => expect(useSetup.getState().open).toBe(false));
    expect(useUi.getState().selectedCardId[BOARD_WS]).toBe("c9");
  });

  it("not offered once the guided card shipped", async () => {
    await openReady(
      withGuide(guideOn("c9", { outcome: "shipped", endedAt: "2026-09-28T12:00:00Z" })),
      [tool("git", true), tool("claude", true)],
      { level: "fast" },
    );
    expect(screen.queryByRole("button", { name: /guided first card/ })).toBeNull();
  });

  it("Open Lyra leads; the 1-minute tour is the body's quiet offer, and it starts once Setup closes", async () => {
    const { user } = await openReady(withGuide(null), [tool("git", true), tool("claude", true)], { level: "fast" });
    const offer = screen.getByRole("button", { name: "Take a 1-minute tour" });
    expect(foot().contains(offer)).toBe(false);
    const open = within(foot()).getByRole("button", { name: "Open Lyra" });
    expect(open.className).toContain("accent");
    expect(screen.queryByRole("button", { name: "Start the tour" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Try a guided first card" })).toBeNull();
    await user.click(offer);
    await waitFor(() => expect(useSetup.getState().open).toBe(false));
    await waitFor(() => expect(useQuickTour.getState().quick?.index).toBe(0));
    expect(useSettings.getState().settings.onboarding.tutorial?.startedAt ?? null).toBeNull();
    act(() => endQuickTour());
  });
});

// ── TU-5: Start the tour, with UX P-C's project settings ────────────────

const foot = () => document.querySelector<HTMLElement>(".ux-setup-foot")!;
const tutorial = () => useSettings.getState().settings.onboarding.tutorial ?? null;

async function startTourButton(): Promise<HTMLButtonElement> {
  let found: HTMLButtonElement | null = null;
  await waitFor(() => {
    const button = within(foot()).getByRole("button", { name: "Start the tour" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    found = button;
  });
  return found!;
}

const proposalView = {
  state: "proposal",
  config: { schemaVersion: 2, targetBranch: "main", versionFiles: [], installScript: null, verifyPipeline: null },
  branches: ["main"],
  suggestedBranch: null,
  branchFrom: "head",
  head: "branch",
  headBranch: "main",
  detectedVerify: null,
  version: null,
  readOnly: false,
};

describe("TU-5: Ready leads with Start the tour for \"I'm new to this\"", () => {
  it("the footer's primary is Start the tour, with the spec's sentence; Open Lyra is quiet beside it; no guided card", async () => {
    await openReady(withGuide(null), [tool("git", true), tool("claude", true)]);
    const start = await startTourButton();
    expect(start.className).toContain("accent");
    // 1.176.3: the other way out says what it does.
    const open = within(foot()).getByRole("button", { name: "Not now, open Lyra" });
    expect(open.className).not.toContain("accent");
    expect(screen.getAllByRole("button", { name: "Start the tour" })).toHaveLength(1);
    const text = screen.getByRole("dialog").textContent;
    // 1.176.3: says what the tour is, by Help's name for it.
    expect(text).toContain(
      "The Getting started tour points at the real buttons while you build your first card in Lyra. It never presses anything for you. Stop whenever you like; Help › Getting started picks it up again.",
    );
    // 1.176.3 (walk): the sentence sits above the summary, so it is read
    // with the footer's buttons without a scroll (the fold itself needs the walk).
    const sentence = screen.getByText(/^The Getting started tour points at the real buttons/);
    const summary = screen.getByRole("group", { name: "What you have" });
    expect(sentence.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 1.171.0 (Block A walk): no time estimate — the build takes what it takes.
    expect(text).not.toMatch(/About \d+ minutes|plus the build/);
    expect(text).not.toContain("Later: Help (?)");
    // The guided first card is the tour's B3 now, not Ready's.
    expect(screen.queryByRole("button", { name: /guided first card/ })).toBeNull();
    expect(text).not.toContain("Plyloft walks you through one small task");
  });

  it("the press closes Setup and starts the tour in Setup's project, the panel open; no card is made", async () => {
    const { user, tauri } = await openReady(withGuide(null), [tool("git", true), tool("claude", true)], {
      fixtures: { "plugin:app|version": "1.167.0" },
    });
    act(() => useUi.setState({ centerMode: { [BOARD_WS]: "code" } }));
    await user.click(await startTourButton());
    await waitFor(() => expect(useSetup.getState().open).toBe(false));
    await waitFor(() => expect(tutorial()?.startedAt).toBeTruthy());
    expect(tutorial()).toMatchObject({ path: "full", paused: false });
    // Setup's project is the active one; the tour follows it until B3 takes
    // a card (TU-5), so no workspace is recorded.
    expect(useWorkspaces.getState().activeId).toBe(BOARD_WS);
    expect(tutorial()?.workspaceId ?? null).toBeNull();
    expect(useTutorialRuntime.getState().panelOpen).toBe(true);
    expect(tauri.callsOf("kanban_card_create")).toHaveLength(0);
    // The Board is the tour's own step (B2): Setup does not open it.
    expect(useUi.getState().centerMode[BOARD_WS]).toBe("code");
  });

  it("a tour under way: Resume the tour", async () => {
    const settings = withGuide(null);
    await openReady(
      {
        ...settings,
        onboarding: {
          ...settings.onboarding,
          tutorial: { startedAt: "2026-10-21T09:00:00Z", path: "full", workspaceId: BOARD_WS, cardId: "c1" },
        },
      },
      [tool("git", true), tool("claude", true)],
    );
    expect(await within(foot()).findByRole("button", { name: "Resume the tour" })).toBeTruthy();
  });

  // TU-5 walk: a tour begun in another project (Vega), Setup rerun with Lyra.
  const withTutorial = (tutorial: TutorialProgress): Settings => {
    const settings = withGuide(null);
    return { ...settings, onboarding: { ...settings.onboarding, tutorial } };
  };
  const OLD_START = "2026-10-20T09:00:00.000Z";

  it("a tour that got no further than B1: Start the tour, from B1, in Setup's project", async () => {
    const { user } = await openReady(
      withTutorial({ startedAt: OLD_START, path: "full", workspaceId: "ws-vega", done: { "base.how-it-works": OLD_START } }),
      [tool("git", true), tool("claude", true)],
      { fixtures: { "plugin:app|version": "1.167.0", workspace_set_active: null } },
    );
    expect(within(foot()).queryByRole("button", { name: "Resume the tour" })).toBeNull();
    await user.click(await startTourButton());
    await waitFor(() => expect(tutorial()?.startedAt).not.toBe(OLD_START));
    expect(tutorial()?.done).toEqual({});
    expect(tutorial()?.workspaceId ?? null).toBeNull();
    expect(useWorkspaces.getState().activeId).toBe(BOARD_WS);
  });

  it("past B1 with no card: Resume the tour keeps the progress and drops the old project", async () => {
    const { user } = await openReady(
      withTutorial({
        startedAt: OLD_START,
        path: "full",
        workspaceId: "ws-vega",
        done: { "base.how-it-works": OLD_START, "base.open-board": OLD_START },
      }),
      [tool("git", true), tool("claude", true)],
      { fixtures: { "plugin:app|version": "1.167.0", workspace_set_active: null } },
    );
    await user.click(await within(foot()).findByRole("button", { name: "Resume the tour" }));
    await waitFor(() => expect(useSetup.getState().open).toBe(false));
    await waitFor(() => expect(tutorial()?.workspaceId ?? null).toBeNull());
    expect(tutorial()?.startedAt).toBe(OLD_START);
    expect(tutorial()?.done?.["base.open-board"]).toBe(OLD_START);
  });

  it("a card under way in another project: Resume the tour keeps it there", async () => {
    const { user } = await openReady(
      withTutorial({ startedAt: OLD_START, path: "full", workspaceId: "ws-vega", cardId: "v1", done: { "base.new-card": OLD_START } }),
      [tool("git", true), tool("claude", true)],
      { fixtures: { "plugin:app|version": "1.167.0", workspace_set_active: null } },
    );
    await user.click(await within(foot()).findByRole("button", { name: "Resume the tour" }));
    await waitFor(() => expect(useSetup.getState().open).toBe(false));
    await waitFor(() => expect(useTutorialRuntime.getState().panelOpen).toBe(true));
    expect(tutorial()).toMatchObject({ startedAt: OLD_START, workspaceId: "ws-vega", cardId: "v1" });
  });

  it("an ended tour with a card elsewhere: Start the tour starts from B1 in Setup's project", async () => {
    const { user } = await openReady(
      withTutorial({
        startedAt: OLD_START,
        path: "full",
        workspaceId: "ws-vega",
        cardId: "v1",
        endedAt: OLD_START,
        done: { "base.how-it-works": OLD_START, "base.new-card": OLD_START },
      }),
      [tool("git", true), tool("claude", true)],
      { fixtures: { "plugin:app|version": "1.167.0", workspace_set_active: null } },
    );
    await user.click(await startTourButton());
    await waitFor(() => expect(tutorial()?.endedAt ?? null).toBeNull());
    expect(tutorial()?.cardId ?? null).toBeNull();
    expect(tutorial()?.workspaceId ?? null).toBeNull();
    expect(tutorial()?.done).toEqual({});
  });

  it("1.176.4: no AI tool ready: Open Lyra leads, the tour isn't offered, and the title says what is left", async () => {
    await openReady(withGuide(null), [tool("git", true), tool("claude", false), tool("codex", false)]);
    await waitFor(() => expect(within(foot()).getByRole("button", { name: "Open Lyra" }).className).toContain("accent"));
    expect(screen.queryByRole("button", { name: "Start the tour" })).toBeNull();
    expect(document.querySelector(".ux-setup-steptitle")?.textContent).toBe("Setup isn't finished");
    expect(screen.getByRole("dialog").textContent).toContain("No AI tool is ready, so Plyloft can't build a card yet.");
  });

  it("no project settings yet: the line says what it will use; the press saves them first, then starts the tour", async () => {
    const order: string[] = [];
    const { user, tauri } = await openReady(withGuide(null), [tool("git", true), tool("claude", true)], {
      fixtures: {
        project_config_list: [],
        project_detect_for_setup: proposalView,
        worktree_settings_get: {},
        project_config_get: null,
        project_config_set: () => {
          order.push("project_config_set");
          return null;
        },
        "plugin:app|version": "1.167.0",
      },
    });
    const line = await waitFor(() => {
      const el = document.querySelector<HTMLElement>("[data-ply-first-card-setup]");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(line.textContent).toContain("Plyloft will build “Lyra” from main, with no checks yet.");
    expect(within(line).getByRole("button", { name: "Change" })).toBeTruthy();
    tauri.fixture("settings_set", ({ settings: next }: Record<string, unknown>) => {
      if ((next as Settings).onboarding.tutorial?.startedAt) order.push("tour");
      return next;
    });
    await user.click(await startTourButton());
    await waitFor(() => expect(tutorial()?.startedAt).toBeTruthy());
    expect(order[0]).toBe("project_config_set");
    expect(order).toContain("tour");
    expect(tauri.callsOf("project_config_set")[0].args).toMatchObject({
      workspaceId: BOARD_WS,
      config: { targetBranch: "main", verifyPipeline: null },
    });
    expect(tauri.callsOf("kanban_card_create")).toHaveLength(0);
  });

  it("(Reviewer) a config saved since Ready read it is kept: the press starts the tour without overwriting it", async () => {
    const { user, tauri } = await openReady(withGuide(null), [tool("git", true), tool("claude", true)], {
      fixtures: {
        project_config_list: [],
        project_detect_for_setup: { ...proposalView, branches: ["main", "develop"] },
        worktree_settings_get: {},
        project_config_get: { schemaVersion: 2, targetBranch: "develop", versionFiles: [], verifyPipeline: null },
        "plugin:app|version": "1.167.0",
      },
    });
    await waitFor(() => expect(document.querySelector("[data-ply-first-card-setup]")).not.toBeNull());
    await user.click(await startTourButton());
    await waitFor(() => expect(tutorial()?.startedAt).toBeTruthy());
    expect(tauri.callsOf("project_config_set")).toHaveLength(0);
  });

  it("(Mac walk 1–2) Setup reopened from Settings: Setup's own project leads with its line; the press saves it there, closes Settings and tours it", async () => {
    const own = { ...boardWorkspace, id: "ws-own", name: "pc-guided", cwd: "/tmp/pc-guided" };
    const { user, tauri } = await openReady(withGuide(null), [tool("git", true), tool("claude", true)], {
      fixtures: {
        project_config_list: [[BOARD_WS, { targetBranch: "main" }]],
        project_detect_for_setup: proposalView,
        worktree_settings_get: {},
        project_config_get: null,
        project_config_set: null,
        "plugin:app|version": "1.167.0",
      },
    });
    act(() => {
      useWorkspaces.setState({ workspaces: [boardWorkspace, own], activeId: "ws-own", loaded: true });
      useSetup.setState({ setupCase: "rerun" });
      useUi.getState().setSettingsOverlayOpen(true);
    });
    const line = await waitFor(() => {
      const el = document.querySelector<HTMLElement>("[data-ply-first-card-setup]");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(line.textContent).toContain("Plyloft will build “pc-guided” from main, with no checks yet.");
    await user.click(await startTourButton());
    // Tours it: the active one, which the tour follows until it has a card.
    await waitFor(() => expect(tutorial()?.startedAt).toBeTruthy());
    expect(useWorkspaces.getState().activeId).toBe("ws-own");
    expect(tauri.callsOf("project_config_set")[0].args).toMatchObject({ workspaceId: "ws-own" });
    expect(useUi.getState().settingsOverlayOpen).toBe(false);
  });

  it("Change opens the Project settings step", async () => {
    const { user } = await openReady(withGuide(null), [tool("git", true), tool("claude", true)], {
      fixtures: {
        project_config_list: [],
        project_detect_for_setup: proposalView,
        worktree_settings_get: { worktreeSetup: "npm install" },
      },
    });
    const line = await waitFor(() => {
      const el = document.querySelector<HTMLElement>("[data-ply-first-card-setup]");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(line.textContent).toContain("Plyloft will build “Lyra” from main, running npm install first, with no checks yet.");
    await user.click(within(line).getByRole("button", { name: "Change" }));
    await waitFor(() => expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("How Plyloft builds “Lyra”"));
  });

  it("detection failed: it says so with Set it up; the tour can still start; nothing is saved", async () => {
    const { tauri } = await openReady(withGuide(null), [tool("git", true), tool("claude", true)], {
      fixtures: {
        project_config_list: [],
        project_detect_for_setup: {
          state: "needsBranch",
          config: { schemaVersion: 2, targetBranch: "", versionFiles: [], verifyPipeline: null },
          branches: [],
          head: "detached",
          headBranch: null,
          readOnly: false,
        },
      },
    });
    await waitFor(() =>
      expect(screen.getByRole("dialog").textContent).toContain("Plyloft couldn't read how “Lyra” builds."),
    );
    expect(screen.getByRole("button", { name: "Set it up" })).toBeTruthy();
    // Not the footer's primary while the project's settings are missing, but
    // there, quiet, and pressable.
    const start = screen.getByRole("button", { name: "Start the tour" }) as HTMLButtonElement;
    expect(foot().contains(start)).toBe(false);
    expect(start.disabled).toBe(false);
    expect(tauri.callsOf("project_config_set")).toHaveLength(0);
  });
});

describe("UX P-C: the guided card's Start build", () => {
  const sentence =
    "For this first card, Claude changes files in the card's own copy of your project without stopping to ask. Anything else still asks you, and nothing reaches your main branch until you ship it.";
  const nowText = () => screen.getByRole("region", { name: "Now" }).textContent ?? "";
  const pressStart = async (user: ReturnType<typeof renderUi>["user"]) => {
    const start = document.querySelector<HTMLButtonElement>("[data-ply-primary-action-id='start-build']")!;
    await user.click(start);
  };

  it("one sentence above Start build, and the start asks Rust for the guided mode", async () => {
    useBuilder.setState({ bypassPref: {}, vendorPref: {} });
    const card = boardCard("c1", { title: FIRST_CARD_TITLE, notes: FIRST_CARD_BRIEF });
    const { user, tauri } = openCard(card, withGuide(guideOn("c1")));
    tauri.fixture("builder_start", () => ({ ptyId: "p1", card }));
    expect(nowText()).toContain(sentence);
    await pressStart(user);
    await waitFor(() => expect(tauri.callsOf("builder_start")).toHaveLength(1));
    expect(tauri.callsOf("builder_start")[0].args).toMatchObject({ vendor: "claude", bypass: false, guided: true });
  });

  it("QoL 7.4 (D10): the tour's own first card, on the member's idea, says its bounded start under What you want and asks for the bounded mode; the next card doesn't", async () => {
    useBuilder.setState({ bypassPref: {}, vendorPref: {} });
    // Made in Plyloft during the tour (Challenger: the prudent scope).
    const own = boardCard("c7", {
      title: "Add a contact form",
      notes: "A form on the home page that emails me.",
      createdAt: Date.parse("2026-10-22T09:05:00.000Z"),
    });
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      onboarding: {
        ...DEFAULT_SETTINGS.onboarding,
        tutorial: { startedAt: "2026-10-22T09:00:00.000Z", workspaceId: BOARD_WS, cardId: "c7" },
      },
    };
    const { user, tauri, unmount } = openCard(own, settings);
    tauri.fixture("builder_start", () => ({ ptyId: "p7", card: own }));
    // Owner 2026-11-10: the tour's card says its bounded start once, under
    // What you want — no "For this first card…" above Start build.
    expect(nowText()).not.toContain("For this first card");
    expect(document.querySelector("[data-ply-guided-start]")).toBeNull();
    // Immediacy walk 3a.1 / 3b: the tour's note points at the sentence under
    // What you want — it is there and says the bounded start, and the facts
    // line waits for the first build (no Permissions before it).
    const setup = document.querySelector<HTMLElement>("[data-ply-brief-setup]");
    expect(setup?.textContent).toContain("Claude builds it in a copy of your project, changing files there without asking;");
    expect(setup?.textContent).not.toContain("its own permission setting");
    const said = [...document.querySelectorAll<HTMLElement>("body *")].filter(
      // A picker's list of choices names every choice; nothing else may.
      (e) => e.children.length === 0 && e.tagName !== "OPTION" && (e.textContent ?? "").includes("Uses Claude's own setting"),
    );
    expect(said.map((e) => e.outerHTML)).toEqual([]);
    await pressStart(user);
    await waitFor(() => expect(tauri.callsOf("builder_start")).toHaveLength(1));
    expect(tauri.callsOf("builder_start")[0].args).toMatchObject({ bypass: false, guided: true });
    unmount();

    const next = boardCard("c8", { title: "Add a footer", notes: "A footer with my name.", createdAt: own.createdAt + 1 });
    const second = openCard(next, settings);
    second.tauri.fixture("builder_start", () => ({ ptyId: "p8", card: next }));
    expect(nowText()).not.toContain("For this first card");
    await pressStart(second.user);
    // One stub for the test: the second start is the second call.
    await waitFor(() => expect(second.tauri.callsOf("builder_start")).toHaveLength(2));
    expect(second.tauri.callsOf("builder_start")[1].args).toMatchObject({ cardId: "c8", guided: false });
  });

  it("Codex's sentence says it can't change anything outside the card's copy", () => {
    useBuilder.setState({ bypassPref: {}, vendorPref: {} });
    const card = boardCard("c1", { title: FIRST_CARD_TITLE, notes: FIRST_CARD_BRIEF, builderVendorPref: "codex" });
    openCard(card, withGuide(guideOn("c1")));
    expect(nowText()).toContain(
      "For this first card, Codex changes files in the card's own copy of your project without stopping to ask. Anything outside that copy still asks you, and nothing reaches your main branch until you ship it.",
    );
  });

  it("a second card in the same workspace starts ordinary: no sentence, no guided mode, no bypass", async () => {
    useBuilder.setState({ bypassPref: {}, vendorPref: {} });
    const second = boardCard("c2", { title: "Add a licence", notes: "Add an MIT licence." });
    const { user, tauri } = openCard(second, withGuide(guideOn("c1")), [
      boardCard("c1", { title: FIRST_CARD_TITLE, notes: FIRST_CARD_BRIEF }),
    ]);
    tauri.fixture("builder_start", () => ({ ptyId: "p2", card: second }));
    expect(nowText()).not.toContain("For this first card");
    await pressStart(user);
    await waitFor(() => expect(tauri.callsOf("builder_start")).toHaveLength(1));
    expect(tauri.callsOf("builder_start")[0].args).toMatchObject({ bypass: false, guided: false });
  });

  it("the guided task rewritten: the card is ordinary", async () => {
    useBuilder.setState({ bypassPref: {}, vendorPref: {} });
    const card = boardCard("c1", { title: FIRST_CARD_TITLE, notes: `${FIRST_CARD_BRIEF} And add a licence.` });
    const { user, tauri } = openCard(card, withGuide(guideOn("c1")));
    tauri.fixture("builder_start", () => ({ ptyId: "p1", card }));
    expect(nowText()).not.toContain("For this first card");
    // The Guide's own sentence still shows.
    expect(guide()).not.toBeNull();
    await pressStart(user);
    await waitFor(() => expect(tauri.callsOf("builder_start")).toHaveLength(1));
    expect(tauri.callsOf("builder_start")[0].args).toMatchObject({ guided: false });
  });

  it("Build without asking turned on: today's bypass, and the sentence is hidden", async () => {
    useBuilder.setState({ bypassPref: { c1: true }, vendorPref: {} });
    const card = boardCard("c1", { title: FIRST_CARD_TITLE, notes: FIRST_CARD_BRIEF });
    const { user, tauri } = openCard(card, withGuide(guideOn("c1")));
    tauri.fixture("builder_start", () => ({ ptyId: "p1", card }));
    expect(nowText()).not.toContain("For this first card");
    await pressStart(user);
    await waitFor(() => expect(tauri.callsOf("builder_start")).toHaveLength(1));
    expect(tauri.callsOf("builder_start")[0].args).toMatchObject({ bypass: true, guided: false });
    // 1.171.0 (D1, Challenger 2): a kept posture is for that one press.
    expect(useBuilder.getState().bypassPref.c1).toBeUndefined();
    useBuilder.setState({ bypassPref: {} });
  });

  it("a session in the guided mode says “edits without asking”, with its title", () => {
    useBuilder.setState({ bypassPref: {}, vendorPref: {} });
    const card = boardCard("c1", {
      title: FIRST_CARD_TITLE,
      notes: FIRST_CARD_BRIEF,
      columnId: "in_progress",
      worktreePath: "/Users/someone/code/lyra/.plyloft-worktrees/c1",
      lastRunStatus: "running",
      builder: {
        vendor: "claude",
        bypass: false,
        permissionMode: "acceptEdits",
        ptyId: "pty-1",
        sessionLost: false,
        startedAt: Date.now() - 60_000,
        snapshots: [],
      },
    });
    openCard(card, withGuide(guideOn("c1")));
    const words = screen.getByText("edits without asking", { exact: true });
    expect(words.getAttribute("title")).toBe(
      "This first card changes files in its own copy without asking. Anything else still asks.",
    );
    expect(screen.queryByText("without asking", { exact: true })).toBeNull();
  });

  it("the guide ended: the sentence is gone and a Start build asks for nothing", () => {
    useBuilder.setState({ bypassPref: {}, vendorPref: {} });
    const card = boardCard("c1", { title: FIRST_CARD_TITLE, notes: FIRST_CARD_BRIEF });
    openCard(card, withGuide(guideOn("c1", { endedAt: "2026-09-28T11:00:00Z", outcome: "dismissed" })));
    expect(nowText()).not.toContain("For this first card");
  });
});

// 1.175.0 F10 (review of F9, minor 3): the tour's own card starts bounded
// (Edits its copy, with no choice of its own): its Permissions never read
// "Uses Claude's own setting".
describe("F10: the tour's card says how it starts", () => {
  it("names Edits its copy without asking, never Uses Claude's own setting", () => {
    // The tour's own card: made after the tour started.
    const card = boardCard("c1", { title: FIRST_CARD_TITLE, notes: FIRST_CARD_BRIEF, createdAt: Date.parse("2026-10-21T10:00:00Z") });
    const tour = { startedAt: "2026-10-21T09:00:00Z", path: "full" as const, workspaceId: BOARD_WS, cardId: "c1" };
    const settings = withGuide(null);
    openCard(card, { ...settings, onboarding: { ...settings.onboarding, tutorial: tour } });
    // What the card says of how it starts, before Start build — its facts
    // line or the sentence under What you want, whichever it shows.
    const said = [document.querySelector(".ux-props--line"), document.querySelector("[data-ply-brief-setup]")]
      .map((e) => e?.textContent ?? "")
      .join(" ");
    expect(said).toMatch(/Edits its copy without asking|changing files there without asking/);
    expect(said).not.toContain("Uses Claude's own setting");
    expect(said).not.toContain("with its own permission setting");
  });
});

describe("1.171.0 D1: how the Builder asks you, chosen before Start build", () => {
  const pressStart = async (user: ReturnType<typeof renderUi>["user"]) => {
    const start = document.querySelector<HTMLButtonElement>("[data-ply-primary-action-id='start-build']")!;
    await user.click(start);
  };
  // The facts line's (the Run step's own, in its closed section, is the same choice).
  const facts = () => permissionsPick()!;
  const pick = () => facts().querySelector("select") as HTMLSelectElement;

  it("a card nobody built shows the choice beside its Builder, with Settings' default and the honest line", () => {
    useBuilder.setState({ bypassPref: {}, vendorPref: {} });
    openCard(boardCard("c2", { title: "Add a licence", notes: "Add an MIT licence." }), withGuide(null));
    // 1.175.0 F10: before the first build the sentence under What you want
    // says it; its Change… holds the choice.
    expect(document.querySelector("[data-ply-brief-setup]")!.textContent).toContain("with its own permission setting");
    expect(pick().value).toBe("asks");
    expect([...pick().options].map((o) => o.textContent)).toEqual([
      "Edits its copy without asking",
      "Uses Claude's own setting",
      "Never asks (risky)",
    ]);
    expect(facts().textContent).toContain(
      "Plyloft adds nothing: Claude follows its own permission setting on this Mac. Unless you changed it, Claude asks before it changes a file or runs a command. Your project itself changes only when you press Ship it.",
    );
  });

  it("Settings' default is what a new card shows; Codex's line says what Codex does", () => {
    useBuilder.setState({ bypassPref: {}, vendorPref: {} });
    openCard(
      boardCard("c2", { title: "Add a licence", notes: "Add an MIT licence.", builderVendorPref: "codex" }),
      withGuide(null, { builderPermissions: "editsCopy" }),
    );
    expect(pick().value).toBe("editsCopy");
    expect(facts().textContent).toContain("Codex changes files in this card's copy of your project without asking.");
  });

  it("a choice is saved with the card, and Start build asks for the bypass only for Never asks", async () => {
    useBuilder.setState({ bypassPref: {}, vendorPref: {} });
    const card = boardCard("c2", { title: "Add a licence", notes: "Add an MIT licence." });
    const { user, tauri } = openCard(card, withGuide(null));
    tauri.fixture("kanban_card_set_builder_permissions", ({ permissions }: Record<string, unknown>) => ({
      ...card,
      builderPermissions: permissions,
    }));
    tauri.fixture("builder_start", () => ({ ptyId: "p2", card }));
    await user.selectOptions(pick(), "neverAsks");
    await waitFor(() => expect(tauri.callsOf("kanban_card_set_builder_permissions")).toHaveLength(1));
    expect(tauri.callsOf("kanban_card_set_builder_permissions")[0].args).toMatchObject({
      cardId: "c2",
      permissions: "neverAsks",
    });
    expect(pick().value).toBe("neverAsks");
    await pressStart(user);
    await waitFor(() => expect(tauri.callsOf("builder_start")).toHaveLength(1));
    expect(tauri.callsOf("builder_start")[0].args).toMatchObject({ bypass: true, guided: false });
  });

  it("the tour card shows its own mode until it has a choice; a choice of its own wins", async () => {
    useBuilder.setState({ bypassPref: {}, vendorPref: {} });
    const card = boardCard("c1", { title: FIRST_CARD_TITLE, notes: FIRST_CARD_BRIEF });
    const { unmount } = openCard(card, withGuide(guideOn("c1")));
    expect(pick().value).toBe("editsCopy");
    unmount();
    const chosen = { ...card, builderPermissions: "asks" as const };
    const { user, tauri } = openCard(chosen, withGuide(guideOn("c1")));
    tauri.fixture("builder_start", () => ({ ptyId: "p1", card: chosen }));
    expect(pick().value).toBe("asks");
    expect(screen.getByRole("region", { name: "Now" }).textContent ?? "").not.toContain("For this first card");
    await pressStart(user);
    await waitFor(() => expect(tauri.callsOf("builder_start")).toHaveLength(1));
    expect(tauri.callsOf("builder_start")[0].args).toMatchObject({ bypass: false, guided: false });
  });

  it("a session started in a choice says so, and the choice is no longer offered", () => {
    useBuilder.setState({ bypassPref: {}, vendorPref: {} });
    const card = boardCard("c2", {
      title: "Add a licence",
      notes: "Add an MIT licence.",
      columnId: "in_progress",
      worktreePath: "/Users/someone/code/lyra/.plyloft-worktrees/c2",
      lastRunStatus: "running",
      builder: {
        vendor: "codex",
        bypass: false,
        permissions: "editsCopy",
        ptyId: "pty-2",
        sessionLost: false,
        startedAt: Date.now() - 60_000,
        snapshots: [],
      },
    });
    openCard(card, withGuide(null));
    expect(screen.getByText("edits its copy without asking", { exact: true }).getAttribute("title")).toBe(
      "Started as Edits its copy without asking",
    );
    expect(document.querySelector("[data-ply-builder-permissions]")).toBeNull();
  });
});

describe("1.172.0 A2: how the Builder asks, chosen again before a new start", () => {
  const facts = () => permissionsPick();
  const pick = () => facts()!.querySelector("select") as HTMLSelectElement;
  const nowBox = () => within(screen.getByRole("region", { name: "Now" }));
  const closed = (patch: Record<string, unknown> = {}) =>
    ({ vendor: "codex", bypass: false, ptyId: null, sessionLost: false, startedAt: 1, snapshots: [], ...patch }) as KanbanCard["builder"];
  const saveFixture = (tauri: ReturnType<typeof renderUi>["tauri"]) =>
    tauri.fixture("kanban_card_set_builder_permissions", ({ permissions }: Record<string, unknown>) => ({
      ...useKanban.getState().byWorkspace[BOARD_WS]!.cards[0],
      builderPermissions: permissions,
    }));

  it("Session closed: the choice is offered, preset to the closed session's; Start fresh starts in the one chosen", async () => {
    useBuilder.setState({ byCard: {}, bypassPref: {}, vendorPref: {} });
    const card = boardCard("c3", {
      notes: "Do it",
      columnId: "in_progress",
      lastRunStatus: "running",
      builderVendorPref: "codex",
      builder: closed({ permissions: "asks" }),
    });
    const { user, tauri } = openCard(card, withGuide(null));
    saveFixture(tauri);
    tauri.fixture("builder_start", () => ({}));
    expect(nowBox().getByText("Session closed")).toBeTruthy();
    expect(pick().value).toBe("asks");
    expect(facts()!.textContent).toContain(
      "Start fresh starts in this choice. Resume goes on as the closed session began: Asks before every change.",
    );
    await user.selectOptions(pick(), "editsCopy");
    await waitFor(() => expect(tauri.callsOf("kanban_card_set_builder_permissions")).toHaveLength(1));
    expect(tauri.callsOf("kanban_card_set_builder_permissions")[0].args).toMatchObject({ cardId: "c3", permissions: "editsCopy" });
    await waitFor(() => expect(pick().value).toBe("editsCopy"));
    await user.click(nowBox().getByRole("button", { name: "Start fresh" }));
    await waitFor(() => expect(tauri.callsOf("builder_start")).toHaveLength(1));
    // The card's own choice now: nothing saved again, no bypass asked for.
    expect(tauri.callsOf("kanban_card_set_builder_permissions")).toHaveLength(1);
    expect(tauri.callsOf("builder_start")[0].args).toMatchObject({ vendor: "codex", bypass: false });
  });

  it("Start fresh untouched starts in the choice shown, and keeps it on the card — a session from before 1.171 without asking is Never asks", async () => {
    useBuilder.setState({ byCard: {}, bypassPref: {}, vendorPref: {} });
    const card = boardCard("c3", {
      notes: "Do it",
      columnId: "in_progress",
      lastRunStatus: "running",
      builder: closed({ vendor: "claude", bypass: true }),
    });
    const { user, tauri } = openCard(card, withGuide(null));
    saveFixture(tauri);
    tauri.fixture("builder_start", () => ({}));
    expect(pick().value).toBe("neverAsks");
    expect(facts()!.textContent).toContain("Resume goes on as the closed session began: without asking.");
    await user.click(nowBox().getByRole("button", { name: "Start fresh" }));
    await waitFor(() => expect(tauri.callsOf("builder_start")).toHaveLength(1));
    expect(tauri.callsOf("kanban_card_set_builder_permissions")[0].args).toMatchObject({ permissions: "neverAsks" });
    expect(tauri.callsOf("builder_start")[0].args).toMatchObject({ bypass: true });
  });

  it("Moved back to Ready to start: offered before Start build, with no Resume line; the press keeps it", async () => {
    useBuilder.setState({ byCard: {}, bypassPref: {}, vendorPref: {} });
    const card = boardCard("c3", {
      notes: "Do it",
      columnId: "todo",
      builder: closed({ vendor: "claude", permissions: "editsCopy" }),
    });
    const { user, tauri } = openCard(card, withGuide(null));
    saveFixture(tauri);
    tauri.fixture("builder_start", () => ({}));
    expect(pick().value).toBe("editsCopy");
    expect(facts()!.textContent).not.toContain("Resume");
    await user.click(document.querySelector<HTMLButtonElement>("[data-ply-primary-action-id='start-build']")!);
    await waitFor(() => expect(tauri.callsOf("builder_start")).toHaveLength(1));
    expect(tauri.callsOf("kanban_card_set_builder_permissions")[0].args).toMatchObject({ permissions: "editsCopy" });
  });

  it("never while a session is open", () => {
    useBuilder.setState({ byCard: {}, bypassPref: {}, vendorPref: {} });
    openCard(
      boardCard("c3", {
        notes: "Do it",
        columnId: "in_progress",
        lastRunStatus: "running",
        worktreePath: "/Users/someone/code/lyra/.plyloft-worktrees/c3",
        builder: closed({ permissions: "asks", ptyId: "pty-3", startedAt: Date.now() - 60_000 }),
      }),
      withGuide(null),
    );
    expect(facts()).toBeNull();
  });

  it("a try of Fix failing checks by itself waiting on Codex in Asks before every change says so under Now", () => {
    useBuilder.setState({ byCard: {}, bypassPref: {}, vendorPref: {} });
    const card = boardCard("c3", {
      notes: "Do it",
      columnId: "in_progress",
      lastRunStatus: "success",
      worktreePath: "/Users/someone/code/lyra/.plyloft-worktrees/c3",
      prUrl: "https://github.com/o/r/pull/8",
      prAutoFix: true,
      pr: {
        number: 8,
        state: "open",
        checks: "failing",
        checksTotal: 1,
        checksPassed: 0,
        checksPending: 0,
        failingChecks: [{ name: "test", workflow: "test", url: "https://github.com/o/r/actions/runs/1/job/2" }],
        mergeable: "mergeable",
        reviewDecision: "none",
        headSha: "aaa",
        openedAt: 1,
        checkedAt: 2,
      } as never,
      builder: closed({ permissions: "asks", ptyId: "pty-3", startedAt: Date.now() - 60_000 }),
    });
    usePrAutoFix.setState({ phases: { c3: { step: "working", head: "aaa", attempt: 1, at: Date.now(), snapshots: 0 } } });
    openCard(card, withGuide(null));
    const notes = document.querySelectorAll<HTMLElement>("[data-ply-unattended-asks]");
    expect(notes).toHaveLength(1);
    expect(notes[0].textContent).toContain("Codex asks before every change in this card, so its automatic fixes wait");
    expect(within(notes[0]).getByRole("button", { name: "Use Edits its copy without asking for this card" })).toBeTruthy();
    usePrAutoFix.setState({ phases: {} });
  });

  // A2 Challenger (minor): stopped on the Builder's question, the note is
  // said once — under Now — not again on the ship step's switch.
  it("Fix failing checks by itself stopped on a question: one note, under Now", () => {
    useBuilder.setState({ byCard: {}, bypassPref: {}, vendorPref: {} });
    usePrAutoFix.setState({ phases: {} });
    const card = boardCard("c3", {
      notes: "Do it",
      columnId: "in_progress",
      lastRunStatus: "success",
      worktreePath: "/Users/someone/code/lyra/.plyloft-worktrees/c3",
      prUrl: "https://github.com/o/r/pull/8",
      prAutoFix: true,
      pr: {
        number: 8,
        state: "open",
        checks: "failing",
        checksTotal: 1,
        checksPassed: 0,
        checksPending: 0,
        failingChecks: [{ name: "test", workflow: "test", url: "https://github.com/o/r/actions/runs/1/job/2" }],
        mergeable: "mergeable",
        reviewDecision: "none",
        headSha: "aaa",
        openedAt: 1,
        checkedAt: 2,
        autoFix: { heads: ["aaa"], stopped: { reason: "question", head: "aaa", at: 3 } },
      } as never,
      builder: closed({ permissions: "asks", ptyId: "pty-3", startedAt: Date.now() - 60_000 }),
    });
    openCard(card, withGuide(null));
    const notes = document.querySelectorAll<HTMLElement>("[data-ply-unattended-asks]");
    expect(notes).toHaveLength(1);
    expect(notes[0].textContent).toContain("Codex asks before every change in this card, so its automatic fixes wait");
  });
});

