// Getting started TU-7 (docs/tutorial/TUTORIAL_SPEC.md §3.1, §6.6, §7, §9):
// the optional chapters in the Guide panel, through the real stores and the
// tour's real subscription.
//
// - After the loop, *More, when you're ready* lists the chapters with their
//   length; choosing one shows its steps and its own progress.
// - A chapter completes: its action steps are marked by the app (the Inbox
//   open, History open), its explain steps by Next; then *Chapter done*.
// - Skip chapter skips the rest of the one shown; the list says Done.
// - An optional step's Take me there opens the active workspace's place,
//   never the tour card's workspace.
// - The team chapter is listed in team mode and absent in solo.
// - On one AI, after the loop, *Add a second AI* is offered once: *Not now*
//   skips G3 and the offer goes (Challenger round 1).
import { afterEach, describe, expect, it, vi } from "vitest";
import { TutorialLayer } from "../components/tutorial/TutorialLayer";
import { NextImprovementSection } from "../components/NextImprovementSection";
import { niKey, useNextImprovement } from "../store/nextImprovementStore";
import type { TutorialProgress } from "../lib/settingsShape";
import { BASE_STEPS, CHAPTER_DONE_COPY, MORE_CHAPTERS_HEADING, OPT, STEP } from "../lib/tutorial/manifest";
import type { DoctorReport } from "../ipc";
import { useDoctor } from "../store/doctorStore";
import { useKanban } from "../store/kanbanStore";
import { useLibrary } from "../store/libraryStore";
import { DEFAULT_SETTINGS, useSettings } from "../store/settingsStore";
import { startTutorialSubscription, stopTutorialForTests, useTutorialRuntime } from "../store/tutorialStore";
import { useUi } from "../store/uiStore";
import { useWorkMode } from "../store/workModeStore";
import { useWorkspaces } from "../store/workspaceStore";
import { BOARD_WS, boardCard, boardWorkspace } from "./boardFixtures";
import { act, fireEvent, renderUi, screen, waitFor, within } from "./render";

afterEach(() => {
  stopTutorialForTests();
  act(() => {
    useWorkMode.setState({ mode: null });
    useDoctor.setState({ report: null });
  });
});

const T0 = "2026-10-21T09:00:00.000Z";
const OTHER = { ...boardWorkspace, id: "ws-vega", name: "vega", cwd: "/tmp/vega" };

/** The loop done: Ship it recorded, B11 skipped (the panel stays open). */
const loopDone = (patch: Partial<TutorialProgress> = {}): TutorialProgress => ({
  startedAt: T0,
  startedVersion: "1.167.0",
  path: "full",
  workspaceId: BOARD_WS,
  cardId: "c1",
  paused: false,
  done: Object.fromEntries(BASE_STEPS.filter((s) => s.kind !== "interrupt" && s.kind !== "checklist").map((s) => [s.id, T0])),
  skipped: { [STEP.secondCard]: T0 },
  ...patch,
});

function seed(tutorial: TutorialProgress, opts: { mode?: "solo" | "team" | null; active?: string } = {}) {
  act(() => {
    useWorkspaces.setState({ workspaces: [boardWorkspace, OTHER], activeId: opts.active ?? BOARD_WS, loaded: true });
    useKanban.setState({
      byWorkspace: {
        [BOARD_WS]: { cards: [boardCard("c1", { shipStatus: "shipped", columnId: "complete" })], loaded: true },
        [OTHER.id]: { cards: [], loaded: true },
      },
    });
    useSettings.setState({
      settings: { ...DEFAULT_SETTINGS, onboarding: { ...DEFAULT_SETTINGS.onboarding, tutorial } },
      loaded: true,
    });
    useUi.setState({ centerMode: { [BOARD_WS]: "board", [OTHER.id]: "board" }, selectedCardId: {} });
    useWorkMode.setState({ mode: opts.mode === undefined ? "solo" : opts.mode });
    useTutorialRuntime.setState({ panelOpen: true });
  });
}

function renderTour() {
  const view = renderUi(
    <>
      <button type="button" data-ply-tour="nav-inbox">
        Inbox
      </button>
      <button type="button" data-ply-tour="nav-history">
        History
      </button>
      <TutorialLayer covered={false} />
    </>,
    {
      fixtures: {
        settings_set: ({ settings }: Record<string, unknown>) => settings,
        "plugin:app|version": "1.167.0",
        "plugin:log|log": null,
        workspace_set_active: null,
      },
    },
  );
  view.tauri.allowUnhandled();
  startTutorialSubscription();
  return view;
}

const record = () => useSettings.getState().settings.onboarding?.tutorial ?? null;
const panel = () => screen.getByRole("region", { name: "Getting started" });
const currentRow = () => panel().querySelector<HTMLElement>('[aria-current="step"]');
const chapterList = () => within(panel()).getByRole("list", { name: MORE_CHAPTERS_HEADING });
/** Wait for words in the panel (the polite announcement says them too). */
const inPanel = (text: string) => waitFor(() => within(panel()).getByText(text));
const chapterButton = (title: string) =>
  within(chapterList()).getByRole("button", { name: new RegExp(`^${title}`) });

describe("More, when you're ready (§3.1)", () => {
  it("lists the chapters after the loop, each with its length; choosing one shows its steps", async () => {
    seed(loopDone());
    const { user } = renderTour();
    await inPanel("That's the loop");
    expect(within(panel()).getByText(/Pick a chapter below/)).toBeTruthy();
    const rows = within(chapterList()).getAllByRole("button");
    expect(rows.map((b) => b.getAttribute("data-ply-tour-chapter"))).toEqual([
      "inbox-history",
      "talk",
      "terminals",
      "code",
      "library",
      "all-skills",
      "ship-batch",
      "settings-search",
    ]);
    expect(chapterButton("Inbox and History").textContent).toContain("3 steps");

    await user.click(chapterButton("Inbox and History"));
    await waitFor(() => expect(currentRow()?.textContent).toContain("Open the Inbox"));
    expect(within(panel()).getByText("Inbox and History", { selector: ".ux-tour-chapter" })).toBeTruthy();
    expect(within(panel()).getByText("0 of 3")).toBeTruthy();
    // Back to the first card is in the list now.
    expect(chapterButton("Your first card").textContent).toContain("Done");
    // The keyboard goes to the panel's heading, not dropped with the button.
    await waitFor(() => expect(document.activeElement).toBe(within(panel()).getByRole("heading", { name: "Getting started" })));
  });

  it("a chapter completes: the app marks its actions, Next its explanations", async () => {
    seed(loopDone());
    const { user } = renderTour();
    await user.click(await screen.findByRole("button", { name: /^Inbox and History/ }));
    await waitFor(() => expect(currentRow()?.textContent).toContain("Open the Inbox"));
    // I1: the Inbox opened (by the person: the sidebar row, here the store).
    act(() => useUi.getState().setCenterMode(BOARD_WS, "inbox"));
    await waitFor(() => expect(record()?.done?.[OPT.inbox]).toBeTruthy());
    // I2 explains: Next, and Show me its control on screen.
    await waitFor(() => expect(currentRow()?.textContent).toContain("One Inbox for every project"));
    expect(within(currentRow()!).getByRole("button", { name: "Show me" })).toBeTruthy();
    expect(record()?.done?.[OPT.inboxEveryProject]).toBeUndefined();
    await user.click(within(currentRow()!).getByRole("button", { name: "Next" }));
    await waitFor(() => expect(record()?.done?.[OPT.inboxEveryProject]).toBeTruthy());
    // I3: History.
    await waitFor(() => expect(currentRow()?.textContent).toContain("Open History"));
    act(() => useUi.getState().setCenterMode(BOARD_WS, "activity"));
    await waitFor(() => expect(record()?.done?.[OPT.history]).toBeTruthy());
    await inPanel(CHAPTER_DONE_COPY.title);
    expect(within(panel()).getByText("3 of 3")).toBeTruthy();
    expect(currentRow()).toBeNull();
  });

  it("Skip chapter skips the rest of the chapter shown, and the list says Done", async () => {
    seed(loopDone());
    const { user } = renderTour();
    await user.click(await screen.findByRole("button", { name: /^Code and the preview/ }));
    await waitFor(() => expect(currentRow()?.textContent).toContain("Go to file"));
    await user.click(within(panel()).getByRole("button", { name: "More for Getting started" }));
    await user.click(screen.getByRole("menuitem", { name: "Skip chapter" }));
    await waitFor(() => expect(record()?.skipped?.[OPT.codeTryProject]).toBeTruthy());
    expect(record()?.skipped?.[OPT.codeFiles]).toBeTruthy();
    // The base chapter's own record is untouched.
    expect(record()?.done?.[STEP.ship]).toBe(T0);
    await inPanel(CHAPTER_DONE_COPY.title);
    // §6.3: K3 skipped — how to see it running by hand.
    expect(within(panel()).getByText(/Show your running app finds it/)).toBeTruthy();
    await user.click(chapterButton("Your first card"));
    await waitFor(() => expect(chapterButton("Code and the preview").textContent).toContain("Done"));
  });
});

describe("K3 on a plain website (TU-7 Mac walk)", () => {
  it("reads the project's start command once: no command and an index.html make K3 explain-only, in a plain website's words", async () => {
    seed(loopDone({ done: { ...loopDone().done, [OPT.codeFiles]: T0, [OPT.codePreview]: T0 } }));
    const view = renderUi(<TutorialLayer covered={false} />, {
      fixtures: {
        settings_set: ({ settings }: Record<string, unknown>) => settings,
        "plugin:app|version": "1.167.0",
        "plugin:log|log": null,
        workspace_set_active: null,
        project_try_command_get: {
          command: null,
          approved: true,
          shared: false,
          readOnly: false,
          hasConfig: true,
          detection: { kind: "staticSite", file: "index.html" },
        },
      },
    });
    view.tauri.allowUnhandled();
    startTutorialSubscription();
    await view.user.click(await screen.findByRole("button", { name: /^Code and the preview/ }));
    await waitFor(() =>
      expect(currentRow()?.textContent).toContain("Lyra is a plain website, so there is nothing to start. Open its index.html in your browser to see it."),
    );
    expect(currentRow()?.textContent).not.toContain("starts your app");
    expect(within(currentRow()!).queryByRole("button", { name: "Skip this step" })).toBeNull();
    await view.user.click(within(currentRow()!).getByRole("button", { name: "Next" }));
    await waitFor(() => expect(record()?.done?.[OPT.codeTryProject]).toBeTruthy());
    await inPanel(CHAPTER_DONE_COPY.title);
  });
});

describe("an optional chapter follows the active workspace (§9)", () => {
  it("Take me there opens the active workspace's Library, never the tour card's workspace", async () => {
    // The tour card is in lyra; the person is in vega.
    seed(loopDone(), { active: OTHER.id });
    const { user } = renderTour();
    await user.click(await screen.findByRole("button", { name: /^Library/ }));
    await waitFor(() => expect(currentRow()?.textContent).toContain("Skills"));
    expect(within(panel()).queryByText(/This step is in/)).toBeNull();
    await user.click(within(currentRow()!).getByRole("button", { name: "Take me there" }));
    expect(useUi.getState().centerMode[OTHER.id]).toBe("library");
    expect(useUi.getState().centerMode[BOARD_WS]).toBe("board");
    expect(useLibrary.getState().byWorkspace[OTHER.id]?.page).toBe("skills");
    // Landing there is L1 done.
    await waitFor(() => expect(record()?.done?.[OPT.librarySkills]).toBeTruthy());
  });
});

// 1.174.0 (A6 round 1): Next improvement's step opens it on the active
// workspace's Board — early, and shown again if the person hid it.
describe("Take me there to Next improvement", () => {
  it("sets early for the active workspace, shows a hidden section, and its anchor renders", async () => {
    seed(loopDone({ done: { ...loopDone().done, [OPT.chat]: T0, [OPT.planTwoAis]: T0, [OPT.whichTalk]: T0 } }));
    const key = niKey(BOARD_WS, null);
    act(() => useNextImprovement.getState().hide(key, "first-use"));
    const view = renderUi(
      <>
        <NextImprovementSection workspaceId={BOARD_WS} />
        <TutorialLayer covered={false} />
      </>,
      {
        fixtures: {
          settings_set: ({ settings }: Record<string, unknown>) => settings,
          "plugin:app|version": "1.174.0",
          "plugin:log|log": null,
          workspace_set_active: null,
        },
      },
    );
    view.tauri.allowUnhandled();
    startTutorialSubscription();
    await view.user.click(await screen.findByRole("button", { name: /^Talk before you build/ }));
    await waitFor(() => expect(currentRow()?.textContent).toContain("Next improvement: ideas, one at a time"));
    expect(document.querySelector('[data-ply-tour="board-next-improvement"]')).toBeNull();
    await view.user.click(within(currentRow()!).getByRole("button", { name: "Take me there" }));
    expect(useNextImprovement.getState().early[BOARD_WS]).toBe(true);
    expect(useNextImprovement.getState().hidden[key]).toBeNull();
    await waitFor(() => expect(document.querySelector('[data-ply-tour="board-next-improvement"]')).not.toBeNull());
  });
});

// 1.172.0 Mac walk (E1): on a shipped card, Take me there for Plan with two
// AIs did nothing and said nothing — its control is only on a card not
// built yet.
describe("Take me there to a card not built yet (Plan with two AIs)", () => {
  const atPlanTwoAis = () => loopDone({ done: { ...loopDone().done, [OPT.chat]: T0 } });
  const openTalk = async (user: ReturnType<typeof renderTour>["user"]) => {
    await user.click(await screen.findByRole("button", { name: /^Talk before you build/ }));
    await waitFor(() => expect(currentRow()?.textContent).toContain("Plan with two AIs"));
  };

  it("from a shipped card, opens a card that isn't built yet", async () => {
    seed(atPlanTwoAis());
    act(() => {
      useKanban.setState({
        byWorkspace: {
          [BOARD_WS]: {
            cards: [boardCard("c1", { shipStatus: "shipped", columnId: "complete" }), boardCard("c2", { notes: "Sort notes" })],
            loaded: true,
          },
          [OTHER.id]: { cards: [], loaded: true },
        },
      });
      useUi.getState().selectCard(BOARD_WS, "c1", true);
    });
    const { user } = renderTour();
    await openTalk(user);
    await user.click(within(currentRow()!).getByRole("button", { name: "Take me there" }));
    expect(useUi.getState().selectedCardId[BOARD_WS]).toBe("c2");
    expect(within(currentRow()!).queryByRole("status")).toBeNull();
  });

  it("with every card built, says so in the step's row instead of doing nothing", async () => {
    seed(atPlanTwoAis());
    act(() => useUi.getState().selectCard(BOARD_WS, "c1", true));
    const { user } = renderTour();
    await openTalk(user);
    await user.click(within(currentRow()!).getByRole("button", { name: "Take me there" }));
    expect(within(currentRow()!).getByRole("status").textContent).toBe(
      "No card here is waiting to be built. Make a new card on the Board, then press Take me there again.",
    );
    // The Board, where a new card is made: the shipped card's page is left.
    expect(useUi.getState().selectedCardId[BOARD_WS] ?? null).toBeNull();
    expect(useUi.getState().centerMode[BOARD_WS]).toBe("board");
    // Once the step's control is on screen, the line goes (Challenger).
    const control = document.createElement("button");
    control.setAttribute("data-ply-tour", "card-plan-two-ais");
    control.textContent = "Plan it first";
    act(() => {
      document.body.appendChild(control);
    });
    await waitFor(() => expect(within(currentRow()!).queryByRole("status")).toBeNull());
    control.remove();
  });

  it("a card opened whose control never shows: after a moment, says it isn't on this card", async () => {
    seed(atPlanTwoAis());
    act(() => {
      useKanban.setState({
        byWorkspace: {
          [BOARD_WS]: {
            cards: [boardCard("c1", { shipStatus: "shipped", columnId: "complete" }), boardCard("c2", { notes: "Sort notes" })],
            loaded: true,
          },
          [OTHER.id]: { cards: [], loaded: true },
        },
      });
    });
    const { user } = renderTour();
    await openTalk(user);
    const press = within(currentRow()!).getByRole("button", { name: "Take me there" });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      fireEvent.click(press);
      expect(useUi.getState().selectedCardId[BOARD_WS]).toBe("c2");
      expect(within(currentRow()!).queryByRole("status")).toBeNull();
      act(() => {
        vi.advanceTimersByTime(1_500);
      });
    } finally {
      vi.useRealTimers();
    }
    expect(within(currentRow()!).getByRole("status").textContent).toBe(
      "It isn't on this card. Open another card on the Board, then press Take me there again.",
    );
  });

  it("a step on any card, with no card open and no tour card: says to open one", async () => {
    seed({ ...loopDone(), cardId: null });
    const { user } = renderTour();
    await user.click(await screen.findByRole("button", { name: /^Talk before you build/ }));
    await waitFor(() => expect(currentRow()?.textContent).toContain("Talk about a card"));
    await user.click(within(currentRow()!).getByRole("button", { name: "Take me there" }));
    expect(within(currentRow()!).getByRole("status").textContent).toBe(
      "Open a card on the Board, then press Take me there again.",
    );
    expect(useUi.getState().centerMode[BOARD_WS]).toBe("board");
  });
});

describe("Your team: team mode only (D7)", () => {
  it("is listed in team mode", async () => {
    seed(loopDone(), { mode: "team" });
    const { user } = renderTour();
    await inPanel("That's the loop");
    await user.click(chapterButton("Your team"));
    await waitFor(() => expect(currentRow()?.textContent).toContain("Your team's skill library"));
    expect(within(panel()).getByText("0 of 3")).toBeTruthy();
  });

  it("is absent in solo", async () => {
    seed(loopDone(), { mode: "solo" });
    renderTour();
    await inPanel("That's the loop");
    expect(within(chapterList()).queryByRole("button", { name: /^Your team/ })).toBeNull();
    expect(within(chapterList()).getAllByRole("button")).toHaveLength(8);
  });
});

describe("Add a second AI after the loop (§6.6 G3, D17)", () => {
  it("is offered once on one AI: Not now skips G3 and the offer goes", async () => {
    seed(loopDone());
    // Claude ready, Codex not installed.
    act(() =>
      useDoctor.setState({
        report: { tools: [{ id: "claude", found: true }, { id: "codex", found: false }] } as unknown as DoctorReport,
      }),
    );
    const { user } = renderTour();
    await inPanel("That's the loop");
    const note = () => panel().querySelector<HTMLElement>("[data-ply-tour-second-ai]");
    await waitFor(() => expect(note()).not.toBeNull());
    expect(within(note()!).getByRole("button", { name: "Add a second AI" })).toBeTruthy();
    await user.click(within(note()!).getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(record()?.skipped?.[OPT.secondAi]).toBeTruthy());
    await waitFor(() => expect(note()).toBeNull());
    // Settings and search still has it, as Skipped.
    await user.click(chapterButton("Settings and search"));
    await waitFor(() => expect(within(panel()).getByText("Add a second AI")).toBeTruthy());
  });
});
