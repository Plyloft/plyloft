// Getting started TU-5 (docs/tutorial/TUTORIAL_SPEC.md §6.2, §6.3, §9, §11):
// the base chapter's panel through the real stores and the tour's real
// subscription.
//
// - B3's other ways: *Use a safe example* makes the guided first card (its
//   record and its permission rule as Setup makes it) and the tour takes it
//   through `withTourCard`; *Continue with* the guided card under way; a
//   card building elsewhere never holds B3; a project with no files gets
//   starter titles.
// - Setup routing: no project → *Finish setup* opens Setup's project step;
//   the tour stands aside while Setup is up and comes back after.
// - The live line (*Claude is working · 3 min*, *Paused until 15:40*), B9's
//   fallback with Details, B11's checklist with Hint.
// - A sheet over the card page hides the panel (it sat over Save and try);
//   a control missing after Take me there is logged once.
import { afterEach, describe, expect, it } from "vitest";
import { GuidePanel, type GuideActions } from "../components/tutorial/GuidePanel";
import { TutorialLayer } from "../components/tutorial/TutorialLayer";
import type { CardPresentationState, KanbanCard } from "../ipc";
import type { SessionFacts } from "../lib/cardPresentation";
import { FIRST_CARD_BRIEF, FIRST_CARD_TITLE } from "../lib/firstCardGuide";
import type { TutorialProgress } from "../lib/settingsShape";
import { STARTER_TITLES, STEP, TRY_FALLBACK } from "../lib/tutorial/manifest";
import { PANEL_FIELD_GAP, panelCap, panelView, placeCoach } from "../lib/tutorial/tourPanel";
import { TYPING_WEIGHT, nearbyControls } from "../lib/tutorial/tourAnchors";
import { buildTutorialSnapshot, completeStep, startFullTour, withTourCard, type SnapshotInput } from "../lib/tutorial/tutorialEngine";
import { useKanban } from "../store/kanbanStore";
import { DEFAULT_SETTINGS, useSettings, type Settings } from "../store/settingsStore";
import { useSetup } from "../store/setupStore";
import { useTryRuns } from "../store/tryRunStore";
import { startTutorialSubscription, stopTutorialForTests, useTutorialRuntime } from "../store/tutorialStore";
import { useUi } from "../store/uiStore";
import { useWorkspaces } from "../store/workspaceStore";
import { BOARD_WS, boardCard, boardWorkspace } from "./boardFixtures";
import { act, renderUi, screen, waitFor, within } from "./render";

afterEach(() => stopTutorialForTests());

const T0 = "2026-10-21T09:00:00.000Z";
const T0_MS = Date.parse(T0);
const AFTER = T0_MS + 60_000;

const running = (patch: Partial<TutorialProgress> = {}): TutorialProgress => ({
  startedAt: T0,
  startedVersion: "1.167.0",
  path: "full",
  workspaceId: BOARD_WS,
  paused: false,
  done: { [STEP.howItWorks]: T0, [STEP.openBoard]: T0 },
  ...patch,
});

function seed(tutorial: TutorialProgress | null, opts: { cards?: KanbanCard[]; settings?: Partial<Settings["onboarding"]>; workspaces?: typeof boardWorkspace[] } = {}) {
  act(() => {
    const workspaces = opts.workspaces ?? [boardWorkspace];
    useWorkspaces.setState({ workspaces, activeId: workspaces[0]?.id ?? null, loaded: true });
    useKanban.setState({ byWorkspace: { [BOARD_WS]: { cards: opts.cards ?? [], loaded: true } } });
    useSettings.setState({
      settings: { ...DEFAULT_SETTINGS, onboarding: { ...DEFAULT_SETTINGS.onboarding, ...opts.settings, tutorial } },
      loaded: true,
    });
    useUi.setState({ centerMode: { [BOARD_WS]: "board" } });
    useTutorialRuntime.setState({ panelOpen: true });
  });
}

function renderTour(fixtures: Record<string, unknown> = {}, covered = false) {
  const view = renderUi(
    <>
      <button type="button" data-ply-tour="nav-board">
        Board
      </button>
      <button type="button" data-ply-tour="board-new-card">
        New card
      </button>
      <TutorialLayer covered={covered} />
    </>,
    {
      fixtures: {
        settings_set: ({ settings }: Record<string, unknown>) => settings,
        "plugin:app|version": "1.167.0",
        "plugin:log|log": null,
        fs_list_dir: [{ name: "index.html", path: "/p/index.html", isDir: false, size: 1 }],
        workspace_set_active: null,
        ...fixtures,
      },
    },
  );
  startTutorialSubscription();
  return view;
}

const record = () => useSettings.getState().settings.onboarding?.tutorial ?? null;
const panel = () => screen.queryByRole("region", { name: "Getting started" });
const currentRow = () => panel()!.querySelector<HTMLElement>('[aria-current="step"]')!;

describe("B3: the other ways to a card (§6.2, §11)", () => {
  it("Use a safe example makes the guided first card, and the tour takes it", async () => {
    seed(running());
    const { user, tauri } = renderTour({
      kanban_load: [],
      kanban_card_create: (args: Record<string, unknown>) => ({
        id: args.cardId,
        workspaceId: args.workspaceId,
        title: args.title,
        notes: args.notes,
        columnId: args.columnId,
        createdAt: AFTER,
        updatedAt: AFTER,
      }),
    });
    await waitFor(() => expect(currentRow().textContent).toContain("Write your idea as a card"));
    await user.click(within(currentRow()).getByRole("button", { name: "No idea yet? Use a safe example" }));
    await waitFor(() => expect(record()?.cardId).toBeTruthy());
    const created = tauri.callsOf("kanban_card_create");
    expect(created).toHaveLength(1);
    expect(created[0].args).toMatchObject({ workspaceId: BOARD_WS, title: FIRST_CARD_TITLE, notes: FIRST_CARD_BRIEF });
    // The tour's card is the guided card, its record as Setup makes it.
    expect(record()?.cardId).toBe(created[0].args.cardId);
    expect(useSettings.getState().settings.onboarding.firstCard).toMatchObject({ cardId: created[0].args.cardId, endedAt: null });
    // Its page is open; B3 is done.
    expect(useUi.getState().selectedCardId[BOARD_WS]).toBe(created[0].args.cardId);
    await waitFor(() => expect(record()?.done?.[STEP.newCard]).toBeTruthy());
  });

  it("the guided card under way: Continue with it, no second README card", async () => {
    const g = boardCard("g", { title: FIRST_CARD_TITLE, notes: FIRST_CARD_BRIEF, createdAt: T0_MS - 1 });
    seed(running(), {
      cards: [g],
      settings: { firstCard: { workspaceId: BOARD_WS, cardId: "g", startedAt: "2026-10-20T09:00:00Z", endedAt: null, outcome: null } },
    });
    const { user } = renderTour();
    const region = await screen.findByRole("region", { name: "Getting started" });
    const button = await within(region).findByRole("button", { name: `Continue with "${FIRST_CARD_TITLE}"` });
    expect(within(region).queryByRole("button", { name: /safe example/ })).toBeNull();
    // TU-5 Mac re-walk: a tour action, whose label wraps in the panel.
    expect(button.parentElement?.classList.contains("ux-tour-actions")).toBe(true);
    await user.click(button);
    await waitFor(() => expect(record()?.cardId).toBe("g"));
    expect(record()?.workspaceId).toBe(BOARD_WS);
    expect(useUi.getState().selectedCardId[BOARD_WS]).toBe("g");
  });

  it("another card building never holds B3: every plan builds in parallel", async () => {
    seed(running(), { cards: [boardCard("busy", { title: "Add a farewell function", createdAt: T0_MS - 1 })] });
    renderTour();
    await waitFor(() => expect(currentRow().textContent).toContain("Write your idea as a card"));
    expect(currentRow().textContent).not.toMatch(/one card builds at a time|Use that card/);
  });

  it("a new, empty project: the starter titles (D25), read once", async () => {
    seed(running());
    // A README and an empty docs folder: folder by folder, never the whole
    // tree (Challenger).
    const { tauri } = renderTour({
      fs_list_dir: ({ path }: Record<string, unknown>) =>
        path === boardWorkspace.cwd
          ? [
              { name: "README.md", path: `${boardWorkspace.cwd}/README.md`, isDir: false, size: 10 },
              { name: "docs", path: `${boardWorkspace.cwd}/docs`, isDir: true, size: 0 },
            ]
          : [],
    });
    await waitFor(() => expect(currentRow().textContent).toContain(STARTER_TITLES[1]));
    for (const title of STARTER_TITLES) expect(currentRow().textContent).toContain(title);
    expect(tauri.callsOf("fs_list_dir")[0].args).toEqual({ path: boardWorkspace.cwd, includeHidden: false });
    expect(tauri.callsOf("fs_list_files_recursive")).toHaveLength(0);
    // The coach-mark offers them too.
    const coach = await screen.findByRole("dialog");
    expect(coach.textContent).toContain(STARTER_TITLES[0]);
    expect(tauri.callsOf("fs_list_dir")).toHaveLength(2);
  });

  it("a project with files: the contact-form example, no starter titles", async () => {
    seed(running());
    renderTour();
    await waitFor(() => expect(currentRow().textContent).toContain('like "Add a contact form"'));
    expect(currentRow().textContent).not.toContain(STARTER_TITLES[1]);
  });
});

describe("B4 after New card + Enter (TU-4 Windows walk)", () => {
  it("a card made on the Board stays there (the Board's own way); B4's Take me there opens its page", async () => {
    seed(running());
    const { user } = renderTour();
    await waitFor(() => expect(currentRow().textContent).toContain("Write your idea as a card"));
    // New card + Enter: the card is on the Board, its page not opened.
    act(() =>
      useKanban.setState({
        byWorkspace: { [BOARD_WS]: { cards: [boardCard("c1", { title: "Add a contact form", createdAt: AFTER })], loaded: true } },
      }),
    );
    await waitFor(() => expect(record()?.cardId).toBe("c1"));
    await waitFor(() => expect(currentRow().textContent).toContain("Say what you want"));
    expect(useUi.getState().selectedCardId[BOARD_WS] ?? null).toBeNull();
    await user.click(within(currentRow()).getByRole("button", { name: "Take me there" }));
    expect(useUi.getState().selectedCardId[BOARD_WS]).toBe("c1");
  });
});

describe("Setup routing (§9, §11)", () => {
  it("no project: Finish setup opens Setup's project step; the tour stands aside and comes back", async () => {
    seed(running({ workspaceId: null, done: { [STEP.howItWorks]: T0 } }), { workspaces: [] });
    const { user, rerender } = renderTour();
    await waitFor(() => expect(currentRow().textContent).toContain("Add your project first"));
    await user.click(within(currentRow()).getByRole("button", { name: "Finish setup" }));
    expect(useSetup.getState()).toMatchObject({ open: true, setupCase: "rerun", step: "project" });
    // App passes `covered` while Setup is up: the tour hides, then returns.
    rerender(
      <>
        <TutorialLayer covered />
      </>,
    );
    expect(panel()).toBeNull();
    act(() => useSetup.getState().closeSetup());
    rerender(
      <>
        <TutorialLayer covered={false} />
      </>,
    );
    expect(await screen.findByRole("region", { name: "Getting started" })).toBeTruthy();
  });
});

describe("the tour stands aside under a sheet (TU-4 walk: Save and try)", () => {
  it("a modal sheet on the page hides the panel; closing it brings it back", async () => {
    seed(running());
    renderTour();
    expect(await screen.findByRole("region", { name: "Getting started" })).toBeTruthy();
    const sheet = document.createElement("div");
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    sheet.textContent = "How to start your app";
    act(() => {
      document.body.appendChild(sheet);
    });
    await waitFor(() => expect(panel()).toBeNull());
    act(() => sheet.remove());
    expect(await screen.findByRole("region", { name: "Getting started" })).toBeTruthy();
  });
});

describe("a control missing after Take me there (§11)", () => {
  it("is logged once in the app's log", async () => {
    seed(running({ done: { [STEP.howItWorks]: T0 } }));
    act(() => useUi.setState({ centerMode: { [BOARD_WS]: "code" } }));
    const view = renderUi(<TutorialLayer covered={false} />, {
      fixtures: {
        settings_set: ({ settings }: Record<string, unknown>) => settings,
        "plugin:log|log": null,
        fs_list_dir: [{ name: "index.html", path: "/p/index.html", isDir: false, size: 1 }],
      },
    });
    startTutorialSubscription();
    await waitFor(() => expect(currentRow().textContent).toContain("Open the Board"));
    await view.user.click(within(currentRow()).getByRole("button", { name: "Take me there" }));
    await waitFor(() => expect(view.tauri.callsOf("plugin:log|log")).toHaveLength(1), { timeout: 4000 });
    expect(JSON.stringify(view.tauri.callsOf("plugin:log|log")[0].args)).toContain("tour anchor missing: nav-board");
  });
});

describe("the store's own reads (Reviewer)", () => {
  const onCard = () =>
    running({ cardId: "c1", done: { [STEP.howItWorks]: T0, [STEP.openBoard]: T0, [STEP.newCard]: T0, [STEP.brief]: T0, [STEP.startBuild]: T0 } });
  const tourCard = () => useTutorialRuntime.getState().snapshot?.tourCard ?? null;

  it("a session resumed after a quit: the live line counts from this launch, not the card's first start", async () => {
    const before = Date.now();
    const resumed = boardCard("c1", {
      columnId: "in_progress",
      notes: "Add a contact form to the home page with name, email and a message.",
      builder: { vendor: "claude", startedAt: before - 2 * 3_600_000, ptyId: "pty-resumed", sessionLost: false } as unknown as KanbanCard["builder"],
    });
    seed(onCard(), { cards: [resumed] });
    renderTour();
    await waitFor(() => expect(tourCard()?.id).toBe("c1"));
    expect(tourCard()!.buildStartedAt).toBeGreaterThanOrEqual(before);
  });

  it("a session started in this launch keeps its own start", async () => {
    const started = Date.now() - 30_000;
    const fresh = boardCard("c1", {
      columnId: "in_progress",
      notes: "Add a contact form to the home page with name, email and a message.",
      builder: { vendor: "claude", startedAt: started, ptyId: "pty-fresh", sessionLost: false } as unknown as KanbanCard["builder"],
    });
    seed(onCard(), { cards: [fresh] });
    renderTour();
    await waitFor(() => expect(tourCard()?.id).toBe("c1"));
    expect(tourCard()!.buildStartedAt).toBe(started);
  });

  it("Save and try closes the sheet onto a start: no fallback in between; closed unsaved: the fallback", async () => {
    const c1 = boardCard("c1", { columnId: "in_progress", notes: "Add a contact form to the home page with name, email and a message." });
    seed(onCard(), { cards: [c1] });
    renderTour();
    await waitFor(() => expect(tourCard()?.id).toBe("c1"));
    const sheet = { card: c1, lane: null, view: null, error: null, busy: false };
    const step = async (next: typeof sheet | null) => {
      await act(async () => {
        useTryRuns.setState({ sheet: next });
        await Promise.resolve();
      });
    };
    await step(sheet);
    await step({ ...sheet, busy: true });
    await step(null);
    expect(tourCard()!.tryFallback).toBe(false);
    // Opened again and closed with nothing saved.
    await step(sheet);
    await step(null);
    await waitFor(() => expect(tourCard()!.tryFallback).toBe(true));
    act(() => useTryRuns.setState({ sheet: null, runs: {} }));
  });
});

describe("no pill once the panel is closed (1.174.0, D3b)", () => {
  it("B10 done, the panel closed: nothing of the tour is drawn over the page", () => {
    seed(running({ done: { [STEP.ship]: T0 } }));
    act(() => useTutorialRuntime.setState({ panelOpen: false }));
    renderTour();
    expect(panel()).toBeNull();
    expect(document.querySelector(".ux-tour-pill")).toBeNull();
    stopTutorialForTests();
  });
});

// ── The panel's drawing, from the pure view ──────────────────────────────

const noop = () => {};
const actions: GuideActions = {
  pause: noop,
  skip: noop,
  unskip: noop,
  complete: noop,
  showMe: noop,
  takeMeThere: noop,
  goToTourWorkspace: noop,
  skipChapter: noop,
  startOver: noop,
  end: noop,
  finishSetup: noop,
  takeCard: noop,
  safeExample: noop,
  chooseChapter: noop,
};

const WS = "ws-1";
function pvFor(
  rec: TutorialProgress,
  cards: KanbanCard[],
  shown: Record<string, { state: CardPresentationState; rule?: "base" | "session-block"; session?: Pick<SessionFacts, "block" | "state">; primary?: string }>,
  now?: number,
) {
  const input: SnapshotInput = {
    record: rec,
    platform: "mac",
    level: "guided",
    workMode: "solo",
    plan: null,
    workspaces: { loaded: true, list: [{ id: WS, name: "lyra" }] },
    activeWorkspaceId: WS,
    mode: "board",
    overlays: { allSkills: false, shipBatch: false, settings: false },
    ai: { claude: true, codex: true },
    boards: { [WS]: { loaded: true, cards } },
    present: (c) => {
      const s = shown[c.id] ?? { state: "draft" as const };
      return {
        state: s.state,
        rule: s.rule ?? "base",
        session: s.session ?? null,
        vendor: "claude",
        primary: (s.primary ?? null) as never,
      };
    },
    tryRuns: {},
  };
  return panelView(rec, buildTutorialSnapshot(input), { now });
}

function upTo(id: string): TutorialProgress {
  let r = withTourCard(startFullTour(null, { now: T0, version: "1.167.0" }), WS, "c1");
  for (const s of [STEP.howItWorks, STEP.openBoard, STEP.newCard, STEP.brief, STEP.startBuild, STEP.finishCheck, STEP.tryIt, STEP.ship]) {
    if (s === id) break;
    r = completeStep(r, s, T0);
  }
  return r;
}

describe("the panel's lines (§3.1, §6.3, §11, D24)", () => {
  const building = boardCard("c1", {
    workspaceId: WS,
    notes: "Add a contact form to the home page with name, email and a message.",
    builder: { vendor: "claude", startedAt: T0_MS } as unknown as KanbanCard["builder"],
  });

  it("the live line names the Builder and its minutes", () => {
    const pv = pvFor(upTo(STEP.finishCheck), [building], { c1: { state: "running", primary: "inspect-run" } }, T0_MS + 3 * 60_000);
    renderUi(<GuidePanel pv={pv} targetShown={false} actions={actions} />);
    const live = document.querySelector<HTMLElement>("[data-ply-tour-live]")!;
    expect(live.dataset.plyTourLive).toBe("running");
    expect(live.textContent).toContain("Claude is working · 3 min");
    expect(live.textContent).toContain("While Claude works: two things worth seeing");
  });

  it("the usage limit: Paused until 15:40, and B5b's words", () => {
    const pv = pvFor(upTo(STEP.finishCheck), [building], {
      c1: { state: "running", rule: "session-block", session: { block: { kind: "usageLimit", resetsAt: "15:40" }, state: "question" }, primary: "inspect-run" },
    });
    renderUi(<GuidePanel pv={pv} targetShown={false} actions={actions} />);
    const live = document.querySelector<HTMLElement>("[data-ply-tour-live]")!;
    expect(live.dataset.plyTourLive).toBe("paused");
    expect(live.textContent).toContain("Paused · your plan's limit resets at 15:40");
    expect(panel()!.textContent).toContain('then type "continue" there. Nothing is lost.');
    expect(panel()!.textContent).toContain("Plyloft never answers for you.");
  });

  it("B9 skipped: the fallback under its row, the command behind Details", async () => {
    const changed = { ...building, worktreePath: "/tmp/c1" };
    const rec = { ...upTo(STEP.tryIt), skipped: { [STEP.tryIt]: T0 } };
    const pv = pvFor(rec, [changed], { c1: { state: "ready-to-ship", primary: "ship" } });
    const { user } = renderUi(<GuidePanel pv={pv} targetShown={false} actions={actions} />);
    const row = panel()!.querySelector<HTMLElement>(`[data-ply-tour-step="${STEP.tryIt}"]`)!;
    const fallback = row.querySelector<HTMLElement>("[data-ply-tour-fallback]")!;
    expect(fallback.textContent).toContain("Open ⋯ on the card and choose \"Open a terminal in the card's copy\"");
    await user.click(within(fallback).getByText("Details"));
    expect(fallback.textContent).toContain(TRY_FALLBACK.beforeShipDetails);
  });

  it("B11: the checklist ticks from the card, with a Hint per row; no Show me", async () => {
    const first = { ...building, shipStatus: "shipped" as const };
    const second = boardCard("c2", { workspaceId: WS, title: "Add a footer", createdAt: T0_MS + 3_600_000 });
    const rec = completeStep(upTo(STEP.ship), STEP.ship, T0);
    const pv = pvFor(rec, [first, second], { c1: { state: "shipped" } });
    const { user } = renderUi(<GuidePanel pv={pv} targetShown={false} actions={actions} />);
    const list = panel()!.querySelector<HTMLElement>(`[data-ply-tour-step="${STEP.secondCard}"]`)!;
    expect(list.textContent).toContain("Try one more card on your own.");
    expect(list.querySelector('[data-ply-tour-check="Title"]')!.textContent).toContain("Done");
    const brief = list.querySelector<HTMLElement>('[data-ply-tour-check="What you want"]')!;
    expect(brief.textContent).not.toContain("Done");
    await user.click(within(brief).getByRole("button", { name: "Hint: What you want" }));
    expect(brief.textContent).toContain("Open the card and write the result");
    expect(within(panel()!).queryByRole("button", { name: "Show me" })).toBeNull();
    expect(panel()!.textContent).toContain("That's the loop");
  });
});

// ── 1.175.0 F4: the permissions question at the end of the tour ────────

describe("F4: the permissions question under That's the loop", () => {
  it("two bordered choices; each press answers, and the panel says so", async () => {
    const first = boardCard("c1", { workspaceId: WS, shipStatus: "shipped" as const, builder: { vendor: "claude", startedAt: T0_MS } as unknown as KanbanCard["builder"] });
    const rec = completeStep(upTo(STEP.ship), STEP.ship, T0);
    const pv = pvFor(rec, [first], { c1: { state: "shipped" } });
    const answers: boolean[] = [];
    const { user } = renderUi(
      <GuidePanel pv={pv} targetShown={false} actions={{ ...actions, answerPermissions: (use) => answers.push(use) }} />,
    );
    const question = panel()!.querySelector<HTMLElement>("[data-ply-tour-permissions]")!;
    expect(within(panel()!).getByRole("group", { name: "How should Claude work on your next cards?" })).toBe(question);
    expect(question.textContent).toContain("Uses Claude's own setting · New cards do this now");
    expect(question.textContent).toContain("Edits its copy without asking");
    const keep = within(question).getByRole("button", { name: "Keep this" });
    const use = within(question).getByRole("button", { name: "Use this" });
    for (const b of [keep, use]) expect(b.className).not.toMatch(/accent|strong|danger/);
    expect(panel()!.textContent).toContain("Describe, build, check, ship.");
    expect(panel()!.textContent).not.toContain("Pick a chapter below");
    await user.click(use);
    await user.click(keep);
    expect(answers).toEqual([true, false]);
  });

  it("the store's answer writes Settings: Use this sets the default, Keep this only records the question", async () => {
    const { answerPermissionsQuestion } = await import("../store/tutorialStore");
    const saved: Settings[] = [];
    useSettings.setState({ settings: DEFAULT_SETTINGS, loaded: true } as never);
    const r = renderUi(<div />, { fixtures: { settings_set: ({ settings }: Record<string, unknown>) => { saved.push(settings as Settings); return settings; } } });
    r.tauri.allowUnhandled();
    await answerPermissionsQuestion(true);
    expect(saved[saved.length - 1]?.onboarding.builderPermissionsAsked).toBe(true);
    expect(saved[saved.length - 1]?.behavior.builderPermissions).toBe("editsCopy");
    useSettings.setState({ settings: DEFAULT_SETTINGS, loaded: true } as never);
    await answerPermissionsQuestion(false);
    expect(saved[saved.length - 1]?.onboarding.builderPermissionsAsked).toBe(true);
    expect(saved[saved.length - 1]?.behavior.builderPermissions).toBe(DEFAULT_SETTINGS.behavior.builderPermissions);
  });
});

// ── TU-5 walk: the tour follows the active workspace until it has a card ─
// A record from a tour begun in Vega names Vega but no card; the user is in
// Lyra now (Setup's new project). B3 must count, look and read there.

const VEGA = { ...boardWorkspace, id: "ws-vega", name: "Vega", cwd: "/Users/someone/code/vega" };

function seedTwo(tutorial: TutorialProgress | null, cards: { lyra?: KanbanCard[]; vega?: KanbanCard[] } = {}) {
  act(() => {
    useWorkspaces.setState({ workspaces: [boardWorkspace, VEGA], activeId: BOARD_WS, loaded: true });
    useKanban.setState({
      byWorkspace: {
        [BOARD_WS]: { cards: cards.lyra ?? [], loaded: true },
        [VEGA.id]: { cards: cards.vega ?? [], loaded: true },
      },
    });
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, onboarding: { ...DEFAULT_SETTINGS.onboarding, tutorial } }, loaded: true });
    useUi.setState({ centerMode: { [BOARD_WS]: "board", [VEGA.id]: "board" } });
    useTutorialRuntime.setState({ panelOpen: true });
  });
}

describe("B3 where you are, before a card (TU-5 walk)", () => {
  it("a card made in the active workspace is taken, and binds the tour there", async () => {
    seedTwo(running({ workspaceId: VEGA.id }));
    renderTour();
    await waitFor(() => expect(currentRow().textContent).toContain("Write your idea as a card"));
    expect(panel()!.textContent).not.toContain("This step is in");
    act(() =>
      useKanban.setState((s) => ({
        byWorkspace: { ...s.byWorkspace, [BOARD_WS]: { cards: [boardCard("n1", { createdAt: AFTER })], loaded: true } },
      })),
    );
    await waitFor(() => expect(record()?.cardId).toBe("n1"));
    expect(record()?.workspaceId).toBe(BOARD_WS);
    expect(record()?.done?.[STEP.newCard]).toBeTruthy();
  });

  it("the empty-project look reads where you are", async () => {
    seedTwo(running({ workspaceId: VEGA.id }));
    const { tauri } = renderTour({
      fs_list_dir: ({ path }: Record<string, unknown>) =>
        path === boardWorkspace.cwd ? [{ name: "README.md", path: `${boardWorkspace.cwd}/README.md`, isDir: false, size: 1 }] : [],
    });
    await waitFor(() => expect(currentRow().textContent).toContain(STARTER_TITLES[1]));
    expect(tauri.callsOf("fs_list_dir").map((c) => c.args.path)).toEqual([boardWorkspace.cwd]);
  });

  it("the tour card deleted: back to B3, which then follows the active workspace", async () => {
    seedTwo(running({ cardId: "gone", done: { [STEP.howItWorks]: T0, [STEP.openBoard]: T0, [STEP.newCard]: T0 } }));
    renderTour({ kanban_load: [] });
    await waitFor(() => expect(record()?.cardId ?? null).toBeNull());
    expect(record()?.workspaceId ?? null).toBeNull();
    // The user moves to Vega and makes a card there: B3 takes it.
    act(() => {
      useWorkspaces.setState({ activeId: VEGA.id });
      useKanban.setState((s) => ({
        byWorkspace: { ...s.byWorkspace, [VEGA.id]: { cards: [boardCard("v1", { workspaceId: VEGA.id, createdAt: AFTER })], loaded: true } },
      }));
    });
    await waitFor(() => expect(record()?.cardId).toBe("v1"));
    expect(record()?.workspaceId).toBe(VEGA.id);
  });
});

// ── TU-5 Mac walk fixes (2026-10-21 walk report) ─────────────────────────

describe("TU-5 Mac walk fixes", () => {
  const onCard = (upToStep: string) => {
    const done: Record<string, string> = {};
    for (const s of [STEP.howItWorks, STEP.openBoard, STEP.newCard, STEP.brief, STEP.startBuild, STEP.finishCheck, STEP.tryIt, STEP.ship]) {
      if (s === upToStep) break;
      done[s] = T0;
    }
    return running({ cardId: "c1", done });
  };

  it("2: Open index.html in How to start your app marks B9 (a plain website, seen in the browser)", async () => {
    const c1 = boardCard("c1", { columnId: "in_progress", notes: "Add a contact form to the home page with name, email and a message.", worktreePath: "/tmp/c1" });
    seed(onCard(STEP.tryIt), { cards: [c1] });
    const { tauri } = renderTour({ try_open_index_html: null });
    await waitFor(() => expect(useTutorialRuntime.getState().snapshot?.tourCard?.id).toBe("c1"));
    const view = { command: null, approved: null, shared: false, readOnly: false, detection: { kind: "staticSite" } } as never;
    await act(async () => {
      useTryRuns.setState({ sheet: { card: c1, lane: null, view, error: null, busy: false } });
      await Promise.resolve();
    });
    await act(async () => {
      await useTryRuns.getState().openIndex();
    });
    expect(tauri.callsOf("try_open_index_html")).toHaveLength(1);
    expect(useTryRuns.getState().sheet).toBeNull();
    await waitFor(() => expect(record()?.done?.[STEP.tryIt]).toBeTruthy());
    expect(useTutorialRuntime.getState().snapshot?.tourCard?.tryFallback).toBe(false);
    act(() => useTryRuns.setState({ sheet: null, runs: {}, indexOpened: {} }));
  });

  it("3: B8 after a quit, the panel on the Inbox: Take me there to the card", async () => {
    const stopped = boardCard("c1", {
      workspaceId: WS,
      notes: "Add a contact form to the home page with name, email and a message.",
      builder: { vendor: "claude", startedAt: T0_MS } as unknown as KanbanCard["builder"],
    });
    const pv = pvFor(upTo(STEP.finishCheck), [stopped], { c1: { state: "session-closed" } });
    expect(pv.view.wait).toBe("stopped");
    const taken: string[] = [];
    const { user } = renderUi(<GuidePanel pv={pv} targetShown={false} actions={{ ...actions, takeMeThere: (s) => taken.push(s.id) }} />);
    const row = panel()!.querySelector<HTMLElement>(`[data-ply-tour-step="${STEP.finishCheck}"]`)!;
    expect(row.textContent).toContain("Something stopped.");
    await user.click(within(row).getByRole("button", { name: "Take me there" }));
    expect(taken).toEqual([STEP.finishCheck]);
  });

  it("3: Take me there on a card step opens the card's page through the store", async () => {
    const c1 = boardCard("c1", { columnId: "in_progress", notes: "Add a contact form to the home page with name, email and a message." });
    seed(onCard(STEP.finishCheck), { cards: [c1] });
    act(() => useUi.setState({ centerMode: { [BOARD_WS]: "inbox" } }));
    const { user } = renderTour();
    await waitFor(() => expect(currentRow().textContent).toContain("When it's finished, check it"));
    await user.click(within(currentRow()).getByRole("button", { name: "Take me there" }));
    expect(useUi.getState().selectedCardId[BOARD_WS]).toBe("c1");
    await waitFor(() => expect(useTutorialRuntime.getState().snapshot?.tourCardOpen).toBe(true));
  });

  it("4, 6: the panel takes a height cap that ends it below a field (panelCap)", () => {
    const view = { height: 1320 };
    const margin = 16;
    // The empty Board's field across the panel's column (g1-starters).
    const field = { left: 495, top: 745, width: 530, height: 40 };
    const cap = panelCap({ left: 945, width: 320 }, [field], view, margin);
    expect(cap).toBe(1320 - 16 - 785 - PANEL_FIELD_GAP);
    // Not over its column: no cap; too little room: no cap.
    expect(panelCap({ left: 1100, width: 160 }, [field], view, margin)).toBeNull();
    expect(panelCap({ left: 945, width: 320 }, [{ ...field, top: 1180 }], view, margin)).toBeNull();
    const pv = pvFor(upTo(STEP.newCard), [], {});
    renderUi(<GuidePanel pv={pv} targetShown={false} actions={actions} cap={300} />);
    expect(panel()!.style.getPropertyValue("--ux-tour-cap")).toBe("300px");
  });

  it("6: B5's coach-mark does not sit on the brief just written (a field costs more than a button)", () => {
    const size = { width: 300, height: 266 };
    const view = { width: 1281, height: 1320 };
    // a7-b5: Start build at the Now box's right, the brief below-left, the
    // card's properties (Status, Builder, Challenger) above.
    const start = { left: 1006, top: 318, width: 99, height: 34 };
    const brief = { left: 399, top: 426, width: 719, height: 117 };
    const props = { left: 778, top: 100, width: 400, height: 180 };
    // Weighed alike, the brief is the cheapest to cover (the walk's place).
    expect(placeCoach(start, size, view, { avoid: [brief, props] }).side).toBe("below");
    expect(placeCoach(start, size, view, { avoid: [{ ...brief, weight: TYPING_WEIGHT }, props] }).side).toBe("above");
    document.body.innerHTML = `<button id="t">Start build</button><textarea id="f"></textarea><button id="b">Plan</button>`;
    const box = (left: number, top: number, w = 100, h = 30) =>
      ({ left, top, right: left + w, bottom: top + h, width: w, height: h, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
    document.getElementById("t")!.getBoundingClientRect = () => box(500, 300);
    document.getElementById("f")!.getBoundingClientRect = () => box(300, 360, 400, 100);
    document.getElementById("b")!.getBoundingClientRect = () => box(620, 300);
    expect(nearbyControls(document.getElementById("t")!, 200)).toEqual([
      { left: 300, top: 360, width: 400, height: 100, weight: TYPING_WEIGHT },
      { left: 620, top: 300, width: 100, height: 30 },
    ]);
    document.body.innerHTML = "";
  });

  it("5: the guided card in a project whose board is not loaded: Continue with it, named once read", async () => {
    const OTHER = { ...boardWorkspace, id: "ws-other", name: "Notes", cwd: "/Users/someone/code/notes" };
    act(() => {
      useWorkspaces.setState({ workspaces: [boardWorkspace, OTHER], activeId: BOARD_WS, loaded: true });
      useKanban.setState({ byWorkspace: { [BOARD_WS]: { cards: [], loaded: true } } });
      useSettings.setState({
        settings: {
          ...DEFAULT_SETTINGS,
          onboarding: {
            ...DEFAULT_SETTINGS.onboarding,
            firstCard: { workspaceId: OTHER.id, cardId: "g", startedAt: "2026-10-20T09:00:00Z", endedAt: null, outcome: null },
            tutorial: running(),
          },
        },
        loaded: true,
      });
      useUi.setState({ centerMode: { [BOARD_WS]: "board" } });
      useTutorialRuntime.setState({ panelOpen: true });
    });
    const g = boardCard("g", { workspaceId: OTHER.id, title: FIRST_CARD_TITLE, notes: FIRST_CARD_BRIEF, createdAt: T0_MS - 1 });
    const { user, tauri } = renderTour({ kanban_load: ({ workspaceId }: Record<string, unknown>) => (workspaceId === OTHER.id ? [g] : []) });
    const region = await screen.findByRole("region", { name: "Getting started" });
    const button = await within(region).findByRole("button", { name: `Continue with "${FIRST_CARD_TITLE}"` });
    expect(tauri.callsOf("kanban_load").filter((c) => c.args.workspaceId === OTHER.id)).toHaveLength(1);
    await user.click(button);
    await waitFor(() => expect(record()?.cardId).toBe("g"));
    expect(record()?.workspaceId).toBe(OTHER.id);
    expect(useUi.getState().selectedCardId[OTHER.id]).toBe("g");
  });
  // Challenger round 1.
  it("C3: its board can't be read: Continue with is not offered, the read not tried again", async () => {
    const OTHER = { ...boardWorkspace, id: "ws-other", name: "Notes", cwd: "/Users/someone/code/notes" };
    act(() => {
      useWorkspaces.setState({ workspaces: [boardWorkspace, OTHER], activeId: BOARD_WS, loaded: true });
      useKanban.setState({ byWorkspace: { [BOARD_WS]: { cards: [], loaded: true } } });
      useSettings.setState({
        settings: {
          ...DEFAULT_SETTINGS,
          onboarding: {
            ...DEFAULT_SETTINGS.onboarding,
            firstCard: { workspaceId: OTHER.id, cardId: "g", startedAt: "2026-10-20T09:00:00Z", endedAt: null, outcome: null },
            tutorial: running(),
          },
        },
        loaded: true,
      });
      useUi.setState({ centerMode: { [BOARD_WS]: "board" } });
      useTutorialRuntime.setState({ panelOpen: true });
    });
    const { tauri } = renderTour({
      kanban_load: ({ workspaceId }: Record<string, unknown>) => {
        if (workspaceId === OTHER.id) throw new Error("unreadable");
        return [];
      },
    });
    const region = await screen.findByRole("region", { name: "Getting started" });
    await waitFor(() => expect(tauri.callsOf("kanban_load").filter((c) => c.args.workspaceId === OTHER.id)).toHaveLength(1));
    await waitFor(() => expect(within(region).queryByRole("button", { name: /^Continue with/ })).toBeNull());
    // Another snapshot (a store change) does not read it again.
    act(() => useUi.setState({ centerMode: { [BOARD_WS]: "board" }, gridVisible: true }));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(tauri.callsOf("kanban_load").filter((c) => c.args.workspaceId === OTHER.id)).toHaveLength(1);
    expect(within(region).queryByRole("button", { name: /safe example/i })).toBeNull();
  });

  it("C2: a card that is gone keeps no Open index.html record (tryRunStore.indexOpened)", () => {
    const c1 = boardCard("c1", { columnId: "in_progress" });
    seed(null, { cards: [c1] });
    const key = `${BOARD_WS}\u0000c1\u0000`;
    act(() => useTryRuns.setState({ indexOpened: { [key]: true } }));
    act(() => useKanban.setState({ byWorkspace: { [BOARD_WS]: { cards: [c1], loaded: true } } }));
    expect(useTryRuns.getState().indexOpened[key]).toBe(true);
    act(() => useKanban.setState({ byWorkspace: { [BOARD_WS]: { cards: [], loaded: true } } }));
    expect(useTryRuns.getState().indexOpened[key]).toBeUndefined();
  });
});
