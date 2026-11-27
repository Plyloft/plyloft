// Getting started TU-2 (TUTORIAL_SPEC §7): the tour's one subscription,
// through the real stores. It writes nothing unless a full tour is started
// and not ended; it records what the stores show (B3's card, steps done);
// a deleted card sends the tour back to B3 only once the disk agrees, and a
// removed workspace does at once. Every write spreads the record.
import { afterEach, describe, expect, it } from "vitest";
import type { KanbanCard } from "../ipc";
import type { TutorialProgress } from "../lib/settingsShape";
import { STEP } from "../lib/tutorial/manifest";
import { useKanban } from "../store/kanbanStore";
import { DEFAULT_SETTINGS, useSettings, type Settings } from "../store/settingsStore";
import {
  startTutorialSubscription,
  stopTutorialForTests,
  tourNavigate,
  useTutorialRuntime,
} from "../store/tutorialStore";
import { useUi } from "../store/uiStore";
import { useWorkspaces } from "../store/workspaceStore";
import { BOARD_WS, boardCard, boardWorkspace } from "./boardFixtures";
import { act, nextFrame, renderUi, waitFor } from "./render";

afterEach(() => stopTutorialForTests());

const T0 = "2026-10-21T09:00:00.000Z";
const AFTER = Date.parse(T0) + 60_000;
const LONG_BRIEF = "Add a contact form to the home page with name, email and a message.";

const tour = (patch: Partial<TutorialProgress> = {}): TutorialProgress & Record<string, unknown> => ({
  startedAt: T0,
  startedVersion: "1.167.0",
  path: "full",
  workspaceId: BOARD_WS,
  paused: false,
  done: { [STEP.howItWorks]: T0, "z99.from-a-newer-app": T0 },
  lastChapter: "terminals",
  ...patch,
});

const withTour = (tutorial: TutorialProgress | null): Settings => ({
  ...DEFAULT_SETTINGS,
  onboarding: { ...DEFAULT_SETTINGS.onboarding, tutorial },
});

function seed(settings: Settings, cards: KanbanCard[], workspaces = [boardWorkspace]): void {
  act(() => {
    useWorkspaces.setState({ workspaces, activeId: workspaces[0]?.id ?? null, loaded: true });
    useKanban.setState({ byWorkspace: { [BOARD_WS]: { cards, loaded: true } } });
    useSettings.setState({ settings, loaded: true });
    useUi.setState({ centerMode: { [BOARD_WS]: "code" } });
  });
}

function render(fixtures: Record<string, unknown> = {}) {
  return renderUi(<div />, {
    fixtures: { settings_set: ({ settings }: Record<string, unknown>) => settings, ...fixtures },
  });
}

const saved = (tauri: ReturnType<typeof renderUi>["tauri"]) => {
  const all = tauri.callsOf("settings_set").map((c) => c.args.settings as Settings);
  return (all[all.length - 1]?.onboarding.tutorial ?? null) as (TutorialProgress & Record<string, unknown>) | null;
};

describe("no tour, no writes", () => {
  it("a record that is not a started tour, or an ended one, is never written", async () => {
    for (const tutorial of [null, { tips: true }, tour({ endedAt: "2026-10-21T10:00:00Z" })]) {
      seed(withTour(tutorial), [boardCard("c1", { createdAt: AFTER, notes: LONG_BRIEF })]);
      const { tauri } = render();
      startTutorialSubscription();
      await nextFrame();
      act(() => useUi.setState({ centerMode: { [BOARD_WS]: "board" } }));
      await nextFrame();
      expect(tauri.callsOf("settings_set")).toHaveLength(0);
      expect(tauri.callsOf("kanban_load")).toHaveLength(0);
      stopTutorialForTests();
    }
  });
});

describe("the record follows the stores", () => {
  it("a card made since the start becomes the tour card, with every step that holds", async () => {
    seed(withTour(tour()), [boardCard("old", { createdAt: Date.parse(T0) - 1 })]);
    const { tauri } = render();
    startTutorialSubscription();
    await nextFrame();
    expect(tauri.callsOf("settings_set")).toHaveLength(0);

    // Out of order: the card is made with its brief while Code is open.
    act(() =>
      useKanban.setState({
        byWorkspace: {
          [BOARD_WS]: {
            cards: [boardCard("old", { createdAt: Date.parse(T0) - 1 }), boardCard("c1", { createdAt: AFTER, notes: LONG_BRIEF })],
            loaded: true,
          },
        },
      }),
    );
    await waitFor(() => expect(saved(tauri)?.cardId).toBe("c1"));
    const t = saved(tauri)!;
    expect(Object.keys(t.done ?? {}).sort()).toEqual(
      [STEP.howItWorks, STEP.newCard, STEP.brief, "z99.from-a-newer-app"].sort(),
    );
    expect(t.lastChapter).toBe("terminals");
    expect(t.startedVersion).toBe("1.167.0");

    // Opening the Board records B2.
    act(() => useUi.setState({ centerMode: { [BOARD_WS]: "board" } }));
    await waitFor(() => expect(saved(tauri)?.done?.[STEP.openBoard]).toBeTruthy());
    const writes = tauri.callsOf("settings_set").length;
    // Nothing new: nothing written.
    act(() => useUi.setState({ allSkillsOpen: false, releaseSheet: null }));
    await nextFrame();
    expect(tauri.callsOf("settings_set")).toHaveLength(writes);
  });

  it("the card shipped records Ship it", async () => {
    seed(withTour(tour({ cardId: "c1" })), [boardCard("c1", { createdAt: AFTER, notes: LONG_BRIEF })]);
    const { tauri } = render();
    startTutorialSubscription();
    await waitFor(() => expect(saved(tauri)?.done?.[STEP.brief]).toBeTruthy());
    act(() =>
      useKanban.setState({
        byWorkspace: {
          [BOARD_WS]: {
            cards: [boardCard("c1", { createdAt: AFTER, notes: LONG_BRIEF, columnId: "complete", shipStatus: "shipped" })],
            loaded: true,
          },
        },
      }),
    );
    await waitFor(() => expect(saved(tauri)?.done?.[STEP.ship]).toBeTruthy());
    expect(saved(tauri)?.done?.[STEP.finishCheck]).toBeTruthy();
    expect(saved(tauri)?.done?.[STEP.startBuild]).toBeTruthy();
  });
});

describe("the tour card gone", () => {
  it("deleted (the disk agrees): back to B3, said once", async () => {
    seed(withTour(tour({ cardId: "c1", done: { [STEP.howItWorks]: T0, [STEP.newCard]: T0, [STEP.brief]: T0, "z99.from-a-newer-app": T0 } })), []);
    const { tauri } = render({ kanban_load: [] });
    startTutorialSubscription();
    await waitFor(() => expect(saved(tauri)).not.toBeNull());
    const t = saved(tauri)!;
    expect(t.cardId).toBeNull();
    // Its workspace goes with it: B3 follows the active one again (TU-5).
    expect(t.workspaceId ?? null).toBeNull();
    expect(Object.keys(t.done ?? {}).sort()).toEqual([STEP.howItWorks, "z99.from-a-newer-app"].sort());
    expect(t.lastChapter).toBe("terminals");
    expect(useTutorialRuntime.getState().cardGone).toBe(true);
    expect(tauri.callsOf("kanban_load")).toHaveLength(1);
  });

  it("a failed board read, or a disk that still has it, changes nothing", async () => {
    seed(withTour(tour({ cardId: "c1" })), []);
    const { tauri } = render({ kanban_load: () => Promise.reject(new Error("disk said no")) });
    startTutorialSubscription();
    await waitFor(() => expect(tauri.callsOf("kanban_load")).toHaveLength(1));
    await nextFrame();
    // The same list is not asked about again.
    act(() => useUi.setState({ centerMode: { [BOARD_WS]: "terminals" } }));
    await nextFrame();
    expect(tauri.callsOf("kanban_load")).toHaveLength(1);
    expect(tauri.callsOf("settings_set")).toHaveLength(0);
    expect(useTutorialRuntime.getState().cardGone).toBe(false);
    stopTutorialForTests();

    tauri.fixture("kanban_load", [boardCard("c1", { createdAt: AFTER })]);
    act(() => useKanban.setState({ byWorkspace: { [BOARD_WS]: { cards: [], loaded: true } } }));
    startTutorialSubscription();
    await waitFor(() => expect(tauri.callsOf("kanban_load")).toHaveLength(2));
    await nextFrame();
    expect(tauri.callsOf("settings_set")).toHaveLength(0);
  });

  it("deleted after Ship it is recorded: nothing asked, nothing written", async () => {
    seed(withTour(tour({ cardId: "c1", done: { [STEP.newCard]: T0, [STEP.ship]: T0 } })), []);
    const { tauri } = render({ kanban_load: [] });
    startTutorialSubscription();
    await nextFrame();
    act(() => useUi.setState({ centerMode: { [BOARD_WS]: "terminals" } }));
    await nextFrame();
    expect(tauri.callsOf("kanban_load")).toHaveLength(0);
    expect(tauri.callsOf("settings_set")).toHaveLength(0);
    expect(useTutorialRuntime.getState().cardGone).toBe(false);
  });

  it("its workspace removed: back to B3 at once, the workspace forgotten", async () => {
    const other = { ...boardWorkspace, id: "ws-2", name: "Vega" };
    seed(withTour(tour({ cardId: "c1", done: { [STEP.newCard]: T0, [STEP.openBoard]: T0 } })), [], [other]);
    const { tauri } = render();
    startTutorialSubscription();
    await waitFor(() => expect(saved(tauri)).not.toBeNull());
    expect(saved(tauri)).toMatchObject({ cardId: null, workspaceId: null });
    expect(saved(tauri)?.done).toEqual({ [STEP.openBoard]: T0 });
    expect(tauri.callsOf("kanban_load")).toHaveLength(0);
  });
});

describe("Take me there (§4.2)", () => {
  it("goes through the existing helpers only", () => {
    seed(withTour(tour({ cardId: "c1" })), [boardCard("c1", { createdAt: AFTER })]);
    render({ workspace_set_active: null }).tauri.allowUnhandled();
    expect(tourNavigate({ mode: "terminals" })).toBe(true);
    expect(useUi.getState().centerMode[BOARD_WS]).toBe("terminals");
    expect(tourNavigate({ allSkills: true })).toBe(true);
    expect(useUi.getState().allSkillsOpen).toBe(true);
    expect(tourNavigate({ card: "tour-card", step: "ship" })).toBe(true);
    expect(useUi.getState().selectedCardId[BOARD_WS]).toBe("c1");
    act(() => useSettings.setState({ settings: withTour(tour({ cardId: null })) }));
    expect(tourNavigate({ card: "tour-card" })).toBe(false);
  });

  it("a tour card whose workspace is gone (after Ship it, nothing is sent back): nowhere to go", () => {
    const other = { ...boardWorkspace, id: "ws-2", name: "Vega" };
    seed(withTour(tour({ cardId: "c1", done: { [STEP.ship]: T0 } })), [], [other]);
    const { tauri } = render({ workspace_set_active: null });
    tauri.allowUnhandled();
    expect(tourNavigate({ card: "tour-card" })).toBe(false);
    expect(tourNavigate({ card: "tour-card", step: "ship" })).toBe(false);
    expect(tourNavigate({ workspace: "tour" })).toBe(false);
    expect(tauri.callsOf("workspace_set_active")).toHaveLength(0);
    expect(useUi.getState().selectedCardId[BOARD_WS] ?? null).toBeNull();
  });

  it("TU-4 re-walk: Take me there to the Board leaves an open card page", () => {
    seed(withTour(tour({ cardId: "c1" })), [boardCard("c1", { createdAt: AFTER })]);
    render({ workspace_set_active: null }).tauri.allowUnhandled();
    expect(tourNavigate({ card: "tour-card" })).toBe(true);
    expect(useUi.getState().selectedCardId[BOARD_WS]).toBe("c1");
    expect(tourNavigate({ mode: "board" })).toBe(true);
    expect(useUi.getState().selectedCardId[BOARD_WS]).toBeNull();
    expect(useUi.getState().centerMode[BOARD_WS]).toBe("board");
  });
});
