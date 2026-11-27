// Getting started TU-4 (docs/tutorial/TUTORIAL_SPEC.md §3, §9, §10): the
// Guide panel, the coach-mark, the Help menu and the sidebar row,
// rendered through the real stores and the tour's real subscription.
//
// - Help › Getting started starts the tour and opens the panel, its heading
//   focused; the panel is a labelled region, never a dialog or modal.
// - The coach-mark points at the one anchor on screen, names the control,
//   gives it `aria-describedby`, never takes focus on appear, hides on Esc
//   and comes back with Show me (which focuses the control).
// - An anchor not on screen: Take me there, through the existing helpers.
// - Pause → no pill (1.174.0, D3b): the sidebar row, its Resume focused; a
//   launch with a tour under way shows only the row, not the open panel;
//   while the panel is open the row has the count and no Resume; End → Help
//   offers it again; Skip this step → Skipped · Do it now.
import { readFileSync } from "node:fs";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TutorialProgress } from "../lib/settingsShape";
import { LOOP_DONE_COPY, STEP } from "../lib/tutorial/manifest";
import { ARROW_REACH, COACH_GAP, RING_OUTSET, RING_WIDTH, offView, placeCoach } from "../lib/tutorial/tourPanel";
import { CoachMark } from "../components/tutorial/CoachMark";
import { findTourAnchor, nearbyControls, NOW_WEIGHT, nowBoxes, popupShown } from "../lib/tutorial/tourAnchors";
import { TutorialLayer } from "../components/tutorial/TutorialLayer";
import { SidebarSlot, SidebarToggle } from "../components/SidebarSlot";
import { HelpMenu, TutorialStatusRow, USER_GUIDE_URL } from "../components/tutorial/HelpMenu";
import { useKanban } from "../store/kanbanStore";
import { DEFAULT_SETTINGS, useSettings, type Settings } from "../store/settingsStore";
import { startTutorialSubscription, stopTutorialForTests, useTutorialRuntime } from "../store/tutorialStore";
import { useUi } from "../store/uiStore";
import { useWorkspaces } from "../store/workspaceStore";
import { BOARD_WS, boardCard, boardWorkspace } from "./boardFixtures";
import { act, nextFrame, renderUi, screen, waitFor, within } from "./render";

afterEach(() => stopTutorialForTests());

const T0 = "2026-10-21T09:00:00.000Z";

const withTour = (tutorial: TutorialProgress | null): Settings => ({
  ...DEFAULT_SETTINGS,
  onboarding: { ...DEFAULT_SETTINGS.onboarding, tutorial },
});

const running = (patch: Partial<TutorialProgress> = {}): TutorialProgress => ({
  startedAt: T0,
  startedVersion: "1.167.0",
  path: "full",
  workspaceId: BOARD_WS,
  paused: false,
  ...patch,
});

function seed(tutorial: TutorialProgress | null) {
  act(() => {
    useWorkspaces.setState({ workspaces: [boardWorkspace], activeId: BOARD_WS, loaded: true });
    useKanban.setState({ byWorkspace: { [BOARD_WS]: { cards: [], loaded: true } } });
    useSettings.setState({ settings: withTour(tutorial), loaded: true });
    useUi.setState({ centerMode: { [BOARD_WS]: "code" } });
  });
}

/** The shell's foot and the layer, with a stand-in Board row (the real
 *  sidebar is rendered by the coverage test). */
function renderTour(opts: { boardRow?: boolean; board?: ReactNode } = {}) {
  const view = renderUi(
    <>
      {opts.board ??
        (opts.boardRow !== false && (
          <button type="button" data-ply-tour="nav-board">
            Board
          </button>
        ))}
      <button type="button">Elsewhere</button>
      <TutorialStatusRow />
      <HelpMenu />
      <TutorialLayer covered={false} />
    </>,
    {
      fixtures: {
        settings_set: ({ settings }: Record<string, unknown>) => settings,
        "plugin:app|version": "1.168.0",
        open_web_link: null,
        // TU-5: B3 reads whether the project has files (D25), and a
        // control missing after Take me there is logged (§11).
        fs_list_dir: [{ name: "index.html", path: "/p/index.html", isDir: false, size: 1 }],
        "plugin:log|log": null,
      },
    },
  );
  startTutorialSubscription();
  return view;
}

const record = () => useSettings.getState().settings.onboarding?.tutorial ?? null;
const sidebarRow = () =>
  [...document.querySelectorAll<HTMLElement>('[role="status"]')].find((el) =>
    el.textContent?.startsWith("Getting started"),
  ) ?? null;
const panel = () => screen.queryByRole("region", { name: "Getting started" });

describe("Help › Getting started (§3.3)", () => {
  it("starts the tour and opens the panel, its heading focused, never a dialog", async () => {
    seed(null);
    const { user } = renderTour();
    await user.click(screen.getByRole("button", { name: "Help" }));
    const menu = screen.getByRole("menu", { name: "Help" });
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
      "Getting started",
      "Take a 1-minute tour",
      "New in this version",
      expect.stringContaining("Keyboard shortcuts"),
      "User guide",
      // QoL 1.168 S3.
      "Check for updates…",
      "Get help",
    ]);
    // TU-6: the tips switch, between them (a menuitemcheckbox).
    expect(within(menu).getByRole("menuitemcheckbox", { name: "Tips when I open a section" })).toBeTruthy();
    await user.click(within(menu).getByRole("menuitem", { name: "Getting started" }));

    await waitFor(() => expect(record()?.startedAt).toBeTruthy());
    expect(record()).toMatchObject({ path: "full", paused: false, startedVersion: "1.168.0" });
    // No workspace is recorded until B3 takes a card (TU-5): the active one.
    expect(record()?.workspaceId ?? null).toBeNull();
    const region = await screen.findByRole("region", { name: "Getting started" });
    expect(region.closest('[role="dialog"]')).toBeNull();
    expect(region.getAttribute("aria-modal")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(within(region).getByRole("heading", { name: "Getting started" })));
    // B1 is current: its words, and Start.
    const current = region.querySelector('[aria-current="step"]')!;
    expect(current.textContent).toContain("How Plyloft works");
    expect(within(region).getByText("0 of 10")).toBeTruthy();
    // The panel leaves every anchor where it was: it covers nothing.
    expect(findTourAnchor("nav-board")).not.toBeNull();
    expect(findTourAnchor("help")).not.toBeNull();
  });

  it("User guide opens the site's guide", async () => {
    seed(null);
    const { user, tauri } = renderTour();
    await user.click(screen.getByRole("button", { name: "Help" }));
    await user.click(screen.getByRole("menuitem", { name: "User guide" }));
    await waitFor(() => expect(tauri.callsOf("open_web_link")).toHaveLength(1));
    expect(tauri.callsOf("open_web_link")[0].args).toEqual({ url: USER_GUIDE_URL });
    expect(USER_GUIDE_URL).toBe("https://www.plyloft.com/docs/");
  });

  it("Keyboard shortcuts opens the existing sheet", async () => {
    seed(null);
    const { user } = renderTour();
    await user.click(screen.getByRole("button", { name: "Help" }));
    await user.click(screen.getByRole("menuitem", { name: /Keyboard shortcuts/ }));
    expect(useUi.getState().shortcutsOpen).toBe(true);
  });
});

describe("the panel and the coach-mark (§3.1, §3.2, §10)", () => {
  it("Start marks B1; B2 points at the Board row without taking focus; Esc hides it, Show me brings it back", async () => {
    seed(running());
    act(() => useTutorialRuntime.setState({ panelOpen: true }));
    const { user } = renderTour();
    const region = await screen.findByRole("region", { name: "Getting started" });
    await user.click(within(region).getByRole("button", { name: "Start" }));
    await waitFor(() => expect(record()?.done?.[STEP.howItWorks]).toBeTruthy());

    const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
    elsewhere.focus();
    const coach = await screen.findByRole("dialog");
    expect(coach.getAttribute("aria-modal")).toBe("false");
    expect(coach.textContent).toContain("Step 2 of 10 · The Board row");
    expect(coach.textContent).toContain("Open the Board");
    // No Next: the action is the real control.
    expect(within(coach).queryByRole("button", { name: "Next" })).toBeNull();
    // The control names the instruction; focus stayed where it was.
    const board = screen.getByRole("button", { name: "Board" });
    const bodyId = coach.getAttribute("aria-describedby")!;
    expect(board.getAttribute("aria-describedby")).toBe(bodyId);
    expect(document.activeElement).toBe(elsewhere);
    // The step change is announced politely.
    expect(document.querySelector('[aria-live="polite"]')!.textContent).toBe("Step 2 of 10: Open the Board");
    // Done and progress in the list.
    expect(within(region).getByText("1 of 10")).toBeTruthy();
    expect(region.querySelector(`[data-ply-tour-step="${STEP.howItWorks}"]`)!.textContent).toContain("Done");

    // Esc on the control hides the coach-mark; the tour goes on.
    board.focus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(board.hasAttribute("aria-describedby")).toBe(false);
    expect(record()?.endedAt ?? null).toBeNull();
    // Show me: back, and the control focused (nothing pressed).
    elsewhere.focus();
    await user.click(within(region).getByRole("button", { name: "Show me" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(document.activeElement).toBe(board);
    expect(useUi.getState().centerMode[BOARD_WS]).toBe("code");
  });

  // 1.171.0 (E2; walk 2026-10-27 #2/#3): a menu opened on the page puts the
  // coach-mark aside; it comes back when the menu closes.
  it("steps aside while a menu of the page is open, and comes back when it closes", async () => {
    seed(running({ done: { [STEP.howItWorks]: T0 } }));
    act(() => useTutorialRuntime.setState({ panelOpen: true }));
    renderTour();
    expect(await screen.findByRole("dialog")).toBeTruthy();
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "More for this card");
    act(() => {
      document.body.appendChild(menu);
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("region", { name: "Getting started" })).toBeTruthy();
    act(() => menu.remove());
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  it("the anchor not on screen: no coach-mark, Take me there through the helpers", async () => {
    seed(running({ done: { [STEP.howItWorks]: T0 } }));
    act(() => useTutorialRuntime.setState({ panelOpen: true }));
    const { user } = renderTour({ boardRow: false });
    const region = await screen.findByRole("region", { name: "Getting started" });
    await nextFrame();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(within(region).queryByRole("button", { name: "Show me" })).toBeNull();
    await user.click(within(region).getByRole("button", { name: "Take me there" }));
    expect(useUi.getState().centerMode[BOARD_WS]).toBe("board");
    // Being on the Board is B2 done (state, never clicks).
    await waitFor(() => expect(record()?.done?.[STEP.openBoard]).toBeTruthy());
  });

  it("Skip this step: Skipped, with Do it now", async () => {
    seed(running({ done: { [STEP.howItWorks]: T0 } }));
    act(() => useTutorialRuntime.setState({ panelOpen: true }));
    const { user } = renderTour();
    const region = await screen.findByRole("region", { name: "Getting started" });
    const current = region.querySelector('[aria-current="step"]') as HTMLElement;
    await user.click(within(current).getByRole("button", { name: "Skip this step" }));
    await waitFor(() => expect(record()?.skipped?.[STEP.openBoard]).toBeTruthy());
    const row = region.querySelector(`[data-ply-tour-step="${STEP.openBoard}"]`) as HTMLElement;
    expect(row.textContent).toContain("Skipped");
    await user.click(within(row).getByRole("button", { name: "Do it now" }));
    await waitFor(() => expect(record()?.skipped?.[STEP.openBoard]).toBeUndefined());
  });
});

describe("the keyboard around the coach-mark (§10, Reviewer)", () => {
  it("Esc in a field or a terminal inside the pointed-at section keeps its own Esc", async () => {
    seed(running({ done: { [STEP.howItWorks]: T0 } }));
    act(() => useTutorialRuntime.setState({ panelOpen: true }));
    const { user } = renderTour({
      board: (
        <div data-ply-tour="nav-board" aria-describedby="own-hint">
          <input aria-label="A field" />
          <div className="xterm">
            <textarea aria-label="Terminal input" />
          </div>
        </div>
      ),
    });
    const coach = await screen.findByRole("dialog");
    const section = document.querySelector<HTMLElement>('[data-ply-tour="nav-board"]')!;
    const bodyId = coach.getAttribute("aria-describedby")!;
    // Its own description is kept beside the coach-mark's.
    expect(section.getAttribute("aria-describedby")).toBe(`own-hint ${bodyId}`);

    screen.getByRole("textbox", { name: "A field" }).focus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeNull();
    screen.getByRole("textbox", { name: "Terminal input" }).focus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeNull();

    // Esc inside the coach-mark: hidden, and only its own id leaves.
    within(coach).getByRole("button", { name: "Skip this step" }).focus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(section.getAttribute("aria-describedby")).toBe("own-hint");
  });

  it("Esc inside the coach-mark gives the keyboard back to the control", async () => {
    seed(running({ done: { [STEP.howItWorks]: T0 } }));
    act(() => useTutorialRuntime.setState({ panelOpen: true }));
    const { user } = renderTour();
    const coach = await screen.findByRole("dialog");
    within(coach).getByRole("button", { name: "Skip this step" }).focus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Board" }));
  });

  it("a press that removes its own button leaves the keyboard on the panel's heading", async () => {
    seed(running({ done: { [STEP.howItWorks]: T0 } }));
    act(() => useTutorialRuntime.setState({ panelOpen: true }));
    const { user } = renderTour();
    const region = await screen.findByRole("region", { name: "Getting started" });
    const current = region.querySelector('[aria-current="step"]') as HTMLElement;
    await user.click(within(current).getByRole("button", { name: "Skip this step" }));
    await waitFor(() => expect(record()?.skipped?.[STEP.openBoard]).toBeTruthy());
    await waitFor(() =>
      expect(document.activeElement).toBe(within(region).getByRole("heading", { name: "Getting started" })),
    );
  });
});

describe("pause, resume, end (§9)", () => {
  it("Pause: no pill, the sidebar row's Resume focused; Resume opens the panel and the row has no second Resume", async () => {
    seed(running({ done: { [STEP.howItWorks]: T0 } }));
    act(() => useTutorialRuntime.setState({ panelOpen: true }));
    const { user } = renderTour();
    const region = await screen.findByRole("region", { name: "Getting started" });
    // The panel open: the row keeps the count, with no Resume (one place).
    await waitFor(() => expect(sidebarRow()?.textContent).toBe("Getting started · 1 of 10"));
    expect(within(sidebarRow()!).queryByRole("button", { name: "Resume" })).toBeNull();
    await user.click(within(region).getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(record()?.paused).toBe(true));
    expect(panel()).toBeNull();
    expect(document.querySelector(".ux-tour-pill")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    const row = sidebarRow()!;
    expect(row.textContent).toBe("Getting started · 1 of 10 · Resume");
    const resume = within(row).getByRole("button", { name: "Resume" });
    await waitFor(() => expect(document.activeElement).toBe(resume));
    expect(useTutorialRuntime.getState().focusRequest).toBeNull();

    await user.click(resume);
    await waitFor(() => expect(record()?.paused).toBe(false));
    const open = await screen.findByRole("region", { name: "Getting started" });
    expect(within(open).getByRole("button", { name: "Pause" })).toBeTruthy();
    expect(sidebarRow()!.textContent).toBe("Getting started · 1 of 10");
    expect(screen.queryAllByRole("button", { name: "Resume" })).toHaveLength(0);
  });

  it("Pause with no sidebar row: the keyboard lands on Help", async () => {
    seed(running({ done: { [STEP.howItWorks]: T0 } }));
    act(() => useTutorialRuntime.setState({ panelOpen: true }));
    const { user } = renderUi(
      <>
        <button type="button" data-ply-tour="nav-board">
          Board
        </button>
        <HelpMenu />
        <TutorialLayer covered={false} />
      </>,
      { fixtures: { settings_set: ({ settings }: Record<string, unknown>) => settings, "plugin:app|version": "1.168.0" } },
    );
    startTutorialSubscription();
    const region = await screen.findByRole("region", { name: "Getting started" });
    await user.click(within(region).getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Help" })));
  });

  // Owner (1.174.0, A8 round 0): with no pill, the row is where a paused
  // B11 resumes — it stays after B10 until B11 is done or skipped.
  it("after B10 the sidebar row and its Resume stay for B11; B11 done or skipped: no row", async () => {
    seed(running({ done: { [STEP.ship]: T0 }, paused: true }));
    renderTour();
    await waitFor(() => expect(sidebarRow()).not.toBeNull());
    expect(within(sidebarRow()!).getByRole("button", { name: "Resume" })).toBeTruthy();
    stopTutorialForTests();
    const ends: Partial<TutorialProgress>[] = [
      { done: { [STEP.ship]: T0, [STEP.secondCard]: T0 } },
      { done: { [STEP.ship]: T0 }, skipped: { [STEP.secondCard]: T0 } },
    ];
    for (const end of ends) {
      seed(running({ ...end, paused: true }));
      const view = renderTour();
      // The row reads the snapshot: wait for it, so "no row" is not just "not yet".
      await waitFor(() => expect(useTutorialRuntime.getState().snapshot).not.toBeNull());
      await nextFrame();
      expect(sidebarRow()).toBeNull();
      view.unmount();
      stopTutorialForTests();
    }
  });

  it("Pause with the sidebar hidden (⌘\\): the keyboard lands on the stage header's Toggle sidebar", async () => {
    seed(running({ done: { [STEP.howItWorks]: T0 } }));
    act(() => {
      const cur = useSettings.getState().settings;
      useSettings.setState({ settings: { ...cur, windows: { settings: null, sidebar: { width: 240, collapsed: true } } } });
      useTutorialRuntime.setState({ panelOpen: true });
    });
    const { user } = renderUi(
      <>
        <SidebarToggle />
        <SidebarSlot>
          {() => (
            <>
              <TutorialStatusRow />
              <HelpMenu />
            </>
          )}
        </SidebarSlot>
        <TutorialLayer covered={false} />
      </>,
      { fixtures: { settings_set: ({ settings }: Record<string, unknown>) => settings, "plugin:app|version": "1.168.0" } },
    );
    startTutorialSubscription();
    const region = await screen.findByRole("region", { name: "Getting started" });
    expect(screen.queryByRole("button", { name: "Help" })).toBeNull();
    await user.click(within(region).getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: /Toggle sidebar/ })));
  });

  it("a launch with a tour under way shows only the sidebar row, not the open panel or a pill, and writes nothing", async () => {
    seed(running({ done: { [STEP.howItWorks]: T0, [STEP.openBoard]: T0 } }));
    const { tauri } = renderTour();
    await waitFor(() => expect(sidebarRow()).not.toBeNull());
    expect(within(sidebarRow()!).getByRole("button", { name: "Resume" })).toBeTruthy();
    expect(panel()).toBeNull();
    expect(document.querySelector(".ux-tour-pill")).toBeNull();
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    await nextFrame();
    expect(tauri.callsOf("settings_set")).toHaveLength(0);
  });

  it("⋯ › End the tour: the panel and the row go; Help offers it again and reopens it where it was", async () => {
    seed(running({ done: { [STEP.howItWorks]: T0 } }));
    act(() => useTutorialRuntime.setState({ panelOpen: true }));
    const { user } = renderTour();
    const region = await screen.findByRole("region", { name: "Getting started" });
    await user.click(within(region).getByRole("button", { name: "More for Getting started" }));
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
      "Skip chapter",
      "Start over",
      "End the tour",
    ]);
    await user.click(screen.getByRole("menuitem", { name: "End the tour" }));
    await waitFor(() => expect(record()?.endedAt).toBeTruthy());
    await waitFor(() => expect(panel()).toBeNull());
    expect(sidebarRow()).toBeNull();

    await user.click(screen.getByRole("button", { name: "Help" }));
    const item = screen.getByRole("menuitem", { name: "Getting started" });
    expect(item.textContent).toContain("Start again");
    await user.click(item);
    await waitFor(() => expect(record()?.endedAt ?? null).toBeNull());
    expect(record()?.done?.[STEP.howItWorks]).toBe(T0);
    expect(record()?.startedAt).toBe(T0);
    expect(await screen.findByRole("region", { name: "Getting started" })).toBeTruthy();
  });

  it("Start over clears what was done; covered by Setup, nothing is drawn", async () => {
    seed(running({ done: { [STEP.howItWorks]: T0 }, seenSections: ["code"] }));
    act(() => useTutorialRuntime.setState({ panelOpen: true }));
    const { user } = renderTour();
    const region = await screen.findByRole("region", { name: "Getting started" });
    await user.click(within(region).getByRole("button", { name: "More for Getting started" }));
    await user.click(screen.getByRole("menuitem", { name: "Start over" }));
    await waitFor(() => expect(record()?.done).toEqual({}));
    expect(record()?.seenSections).toEqual(["code"]);
  });
});

describe("Setup over the shell (§9)", () => {
  it("the layer draws nothing while covered", async () => {
    seed(running());
    act(() => useTutorialRuntime.setState({ panelOpen: true }));
    renderUi(<TutorialLayer covered />, { fixtures: { settings_set: ({ settings }: Record<string, unknown>) => settings } });
    startTutorialSubscription();
    await nextFrame();
    expect(panel()).toBeNull();
  });
});

// 1.172 A3 (Windows walk 2026-10-27-211141, C–F): a step's control scrolled
// off its page is brought into view before the step points at it.
describe("a control scrolled out of view", () => {
  const win = { left: 0, top: 0, width: 1280, height: 800 };
  it("offView: outside the window or a box that clips it; never for an unlaid box", () => {
    expect(offView({ left: 100, top: 100, width: 80, height: 30 }, [win])).toBe(false);
    expect(offView({ left: 100, top: 900, width: 80, height: 30 }, [win])).toBe(true);
    expect(offView({ left: 100, top: -40, width: 80, height: 30 }, [win])).toBe(true);
    const page = { left: 300, top: 60, width: 900, height: 400 };
    expect(offView({ left: 400, top: 500, width: 80, height: 30 }, [win, page])).toBe(true);
    expect(offView({ left: 0, top: 0, width: 0, height: 0 }, [win])).toBe(false);
  });
  it("the coach-mark scrolls its control into view, once", () => {
    const target = document.createElement("button");
    target.textContent = "Open session";
    document.body.appendChild(target);
    target.getBoundingClientRect = () => ({ left: 100, top: 2000, width: 80, height: 30, right: 180, bottom: 2030, x: 100, y: 2000, toJSON: () => ({}) }) as DOMRect;
    const scrolled = vi.fn();
    target.scrollIntoView = scrolled;
    const copy = { title: "Open the session", body: "Press it." } as unknown as Parameters<typeof CoachMark>[0]["copy"];
    const view = renderUi(
      <CoachMark target={target} anchor={{} as Parameters<typeof CoachMark>[0]["anchor"]} copy={copy} number={1} total={3} onHide={() => {}} />,
    );
    expect(scrolled).toHaveBeenCalledTimes(1);
    expect(scrolled).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
    view.rerender(
      <CoachMark target={target} anchor={{} as Parameters<typeof CoachMark>[0]["anchor"]} copy={copy} number={1} total={3} onHide={() => {}} />,
    );
    expect(scrolled).toHaveBeenCalledTimes(1);
    view.unmount();
    target.remove();
  });
  it("a control in view is left where it is", () => {
    const target = document.createElement("button");
    document.body.appendChild(target);
    target.getBoundingClientRect = () => ({ left: 100, top: 100, width: 80, height: 30, right: 180, bottom: 130, x: 100, y: 100, toJSON: () => ({}) }) as DOMRect;
    const scrolled = vi.fn();
    target.scrollIntoView = scrolled;
    const copy = { title: "Open the session", body: "Press it." } as unknown as Parameters<typeof CoachMark>[0]["copy"];
    const view = renderUi(<CoachMark target={target} anchor={{} as Parameters<typeof CoachMark>[0]["anchor"]} copy={copy} number={1} total={3} onHide={() => {}} />);
    expect(scrolled).not.toHaveBeenCalled();
    view.unmount();
    target.remove();
  });
});

describe("where the coach-mark goes (§3.2)", () => {
  const view = { width: 1280, height: 800 };
  const size = { width: 300, height: 160 };
  it("right of a sidebar row, its arrow at the row", () => {
    const at = placeCoach({ left: 8, top: 200, width: 224, height: 32 }, size, view);
    expect(at.side).toBe("right");
    expect(at.left).toBe(8 + 224 + COACH_GAP);
    expect(at.top + at.arrow + 6).toBe(216);
  });
  it("its arrow touches the ring (TU-4 Mac walk: it stopped short)", () => {
    const target = { left: 8, top: 200, width: 224, height: 32 };
    const at = placeCoach(target, size, view);
    const tip = at.left - ARROW_REACH;
    const ringOuter = target.left + target.width + RING_OUTSET;
    // The tip lands on the ring's 2 px line, not in the gap before it.
    expect(tip).toBeLessThanOrEqual(ringOuter);
    expect(tip).toBeGreaterThanOrEqual(ringOuter - RING_WIDTH);
    // And the same below a control.
    const wide = { left: 0, top: 100, width: 1280, height: 60 };
    const below = placeCoach(wide, size, view);
    expect(below.top - ARROW_REACH).toBeLessThanOrEqual(wide.top + wide.height + RING_OUTSET);
    expect(below.top - ARROW_REACH).toBeGreaterThanOrEqual(wide.top + wide.height + RING_OUTSET - RING_WIDTH);
    // ux.css draws what the numbers say: a 12 px square at -7 px.
    expect(css).toMatch(/\.ux-tour-coach-arrow \{[^}]*width: 12px;[^}]*height: 12px;/);
    expect(css).toMatch(/\.ux-tour-coach--right \.ux-tour-coach-arrow \{ left: -7px;/);
  });
  it("left of a control at the window's right edge", () => {
    const at = placeCoach({ left: 1180, top: 300, width: 90, height: 30 }, size, view);
    expect(at.side).toBe("left");
    expect(at.left + size.width).toBe(1180 - COACH_GAP);
  });
  it("a header button: not over its neighbour when a free side exists (TU-4 Mac walk: Review a pull request)", () => {
    // New card at the top right, Review a pull request just left of it.
    const newCard = { left: 1090, top: 40, width: 120, height: 32 };
    const review = { left: 940, top: 40, width: 140, height: 32 };
    expect(placeCoach(newCard, size, view).side).toBe("left");
    const at = placeCoach(newCard, size, view, { avoid: [review] });
    expect(at.side).toBe("below");
  });
  it("covers the least when every side covers something (TU-4 Mac walk: the What you want field)", () => {
    // Start build at the right of the Now box, the brief's field below and
    // left of it, a small select above.
    const start = { left: 1130, top: 380, width: 110, height: 32 };
    const field = { left: 560, top: 300, width: 560, height: 360 };
    const select = { left: 1100, top: 200, width: 120, height: 32 };
    const at = placeCoach(start, size, view, { avoid: [field, select] });
    expect(at.side).toBe("above");
  });
  it("nearbyControls: only shown controls near the target, never the target, a hidden host's or the tour's own", () => {
    document.body.innerHTML = `
      <div><button id="t">Start build</button><button id="near">Plan</button><button id="far">Far</button></div>
      <div class="hidden"><button id="ghost">Start build</button></div>
      <div data-ply-tour-coach><button id="own">Skip this step</button></div>`;
    const box = (left: number, top: number) =>
      ({ left, top, right: left + 100, bottom: top + 30, width: 100, height: 30, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
    const at: Record<string, DOMRect> = {
      t: box(500, 300),
      near: box(620, 300),
      far: box(20, 20),
      ghost: box(620, 300),
      own: box(500, 340),
    };
    for (const [id, r] of Object.entries(at)) document.getElementById(id)!.getBoundingClientRect = () => r;
    const out = nearbyControls(document.getElementById("t")!, 200);
    expect(out).toEqual([{ left: 620, top: 300, width: 100, height: 30 }]);
    document.body.innerHTML = "";
  });
  // 1.171.0 (E2; walk 2026-10-27 #4g): the coach-mark sat on the Now box's
  // Ready to ship. The Now box weighs more than any control.
  it("keeps clear of the card's Now box: a button in it is pointed at from below", () => {
    document.body.innerHTML = `<section class="ux-card-now" aria-label="Now"><p>Ready to ship</p><button id="try">Try it</button></section>`;
    const now = { left: 560, top: 120, width: 680, height: 150 };
    document.querySelector(".ux-card-now")!.getBoundingClientRect = () =>
      ({ ...now, right: now.left + now.width, bottom: now.top + now.height, x: now.left, y: now.top, toJSON: () => ({}) }) as DOMRect;
    const boxes = nowBoxes(document);
    expect(boxes).toEqual([{ ...now, weight: NOW_WEIGHT }]);
    const tryIt = { left: 1000, top: 228, width: 70, height: 30 };
    const at = placeCoach(tryIt, size, view, { avoid: boxes });
    expect(at.side).toBe("below");
    expect(at.top).toBeGreaterThanOrEqual(now.top + now.height - 10);
    document.body.innerHTML = "";
  });
  it("popupShown: an open menu or popover of the page, never the tour's own or a hidden host's", () => {
    document.body.innerHTML = `<div data-ply-tour-coach><div role="menu"></div></div><div class="hidden"><div class="ux-popover"></div></div>`;
    expect(popupShown(document)).toBe(false);
    document.body.insertAdjacentHTML("beforeend", `<div role="menu" aria-label="More for this card"></div>`);
    expect(popupShown(document)).toBe(true);
    document.body.innerHTML = `<div class="ux-popover" role="dialog"></div>`;
    expect(popupShown(document)).toBe(true);
    document.body.innerHTML = "";
  });
  it("below a wide control, kept inside the window", () => {
    const at = placeCoach({ left: 0, top: 100, width: 1280, height: 60 }, size, view);
    expect(at.side).toBe("below");
    expect(at.left).toBeGreaterThanOrEqual(8);
    expect(at.left + size.width).toBeLessThanOrEqual(1280 - 8);
  });
  it("above a wide control at the bottom", () => {
    const at = placeCoach({ left: 0, top: 700, width: 1280, height: 60 }, size, view);
    expect(at.side).toBe("above");
    expect(at.top).toBe(700 - COACH_GAP - 160);
  });
});

const css = readFileSync("src/components/ux/ux.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const shellCss = readFileSync("src/components/shell.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const rule = (sheet: string, selector: string) => {
  const at = sheet.indexOf(`\n${selector} {`);
  expect(at, selector).toBeGreaterThanOrEqual(0);
  return sheet.slice(at, sheet.indexOf("}", at));
};

describe("TU-5 Mac re-walk", () => {
  it("a long action label wraps in the panel, not cut at its edge", () => {
    const wrap = rule(css, ".ux-tour-actions > .cbtn");
    expect(wrap).toMatch(/white-space:\s*normal/);
    expect(wrap).toMatch(/max-width:\s*100%/);
    expect(wrap).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
  });
});

describe("TU-4 Mac walk fixes", () => {
  it("1: Do it now on B6 after Skip chapter makes it the current step, not That's the loop", async () => {
    seed(running({ done: { [STEP.howItWorks]: T0 } }));
    act(() => useTutorialRuntime.setState({ panelOpen: true }));
    const { user } = renderTour();
    const region = await screen.findByRole("region", { name: "Getting started" });
    await user.click(within(region).getByRole("button", { name: "More for Getting started" }));
    await user.click(screen.getByRole("menuitem", { name: "Skip chapter" }));
    await waitFor(() => expect(within(region).getByText(LOOP_DONE_COPY.title)).toBeTruthy());
    const row = region.querySelector(`[data-ply-tour-step="${STEP.watchTerminals}"]`) as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "Do it now" }));
    await waitFor(() => expect(row.getAttribute("aria-current")).toBe("step"));
    expect(within(region).queryByText(LOOP_DONE_COPY.title)).toBeNull();
    // No card yet: the panel says what comes first.
    expect(row.textContent).toContain("Write your idea as a card first");
    // Skipped again: the focus goes with it.
    await user.click(within(row).getByRole("button", { name: "Skip this step" }));
    await waitFor(() => expect(row.getAttribute("aria-current")).toBeNull());
    await waitFor(() => expect(useTutorialRuntime.getState().focus).toBeNull());
  });

  it("2: B5 skipped before the build — B8 waits, and no coach-mark on Start build", async () => {
    const done = { [STEP.howItWorks]: T0, [STEP.openBoard]: T0, [STEP.newCard]: T0, [STEP.brief]: T0 };
    seed(running({ cardId: "c1", done, skipped: { [STEP.startBuild]: T0 } }));
    act(() => {
      useKanban.setState({
        byWorkspace: {
          [BOARD_WS]: {
            cards: [boardCard("c1", { notes: "Add a search box above the notes list that filters as you type." })],
            loaded: true,
          },
        },
      });
      useTutorialRuntime.setState({ panelOpen: true });
    });
    renderTour({
      board: (
        <button type="button" data-ply-tour="card-primary" data-ply-primary-action-id="start-build">
          Start build
        </button>
      ),
    });
    const region = await screen.findByRole("region", { name: "Getting started" });
    await waitFor(() =>
      expect(region.querySelector('[aria-current="step"]')?.getAttribute("data-ply-tour-step")).toBe(STEP.finishCheck),
    );
    expect(region.textContent).toContain("Start the build first");
    expect(within(region).getByText("4 of 10")).toBeTruthy();
    await nextFrame();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.textContent).not.toContain("The Start build button");
  });

  it("3: Start over on the Board is a real restart — 0 of 10 and B1, B2 not done", async () => {
    seed(running({ done: { [STEP.howItWorks]: T0, [STEP.openBoard]: T0 } }));
    act(() => {
      useUi.setState({ centerMode: { [BOARD_WS]: "board" } });
      useTutorialRuntime.setState({ panelOpen: true });
    });
    const { user, tauri } = renderTour();
    const region = await screen.findByRole("region", { name: "Getting started" });
    await user.click(within(region).getByRole("button", { name: "More for Getting started" }));
    await user.click(screen.getByRole("menuitem", { name: "Start over" }));
    await waitFor(() => expect(record()?.done).toEqual({}));
    const writes = tauri.callsOf("settings_set").length;
    await nextFrame();
    await nextFrame();
    expect(record()?.done).toEqual({});
    expect(tauri.callsOf("settings_set")).toHaveLength(writes);
    expect(within(region).getByText("0 of 10")).toBeTruthy();
    expect(region.querySelector('[aria-current="step"]')!.textContent).toContain("How Plyloft works");
    // After B1, B2 is current and the Board already open counts for it.
    await user.click(within(region).getByRole("button", { name: "Start" }));
    await waitFor(() => expect(record()?.done?.[STEP.openBoard]).toBeTruthy());
  });

  it("5: Why? is smaller than the body it follows, and muted", () => {
    const why = rule(css, ".ux-tour-why");
    expect(why).toContain("font-size: var(--type-caption)");
    expect(why).toContain("color: var(--muted)");
    expect(rule(css, ".ux-tour-step-detail")).toContain("font-size: var(--type-small)");
    expect(rule(css, ".ux-tour-coach .ux-tour-why")).toContain("font-size: var(--type-small)");
    expect(rule(css, ".ux-tour-coach")).toContain("font-size: var(--type-ui)");
  });

  it("6: the sidebar row keeps its count and Resume on their own line; its name is whole", async () => {
    seed(running({ done: { [STEP.howItWorks]: T0, [STEP.openBoard]: T0 }, paused: true }));
    renderTour();
    await waitFor(() => expect(sidebarRow()).not.toBeNull());
    const row = sidebarRow()!;
    expect(row.textContent).toBe("Getting started · 2 of 10 · Resume");
    const sub = row.querySelector(".shell-status-sub")!;
    expect(sub.textContent).toBe("2 of 10 · Resume");
    // The count is not inside the part that gives way (ellipsis).
    expect(row.querySelector(".shell-status-text")!.textContent).toBe("Getting started · ");
    expect(rule(shellCss, ".shell-status-sub")).toContain("white-space: nowrap");
  });

  it("8: in Code the panel sits above the status bar, and paused nothing is raised there; a short window keeps the panel compact", async () => {
    seed(running({ done: { [STEP.howItWorks]: T0 } }));
    act(() => useTutorialRuntime.setState({ panelOpen: true }));
    renderTour();
    const open = await screen.findByRole("region", { name: "Getting started" });
    expect(open.className).toContain("ux-tour--lift");
    act(() => useUi.setState({ centerMode: { [BOARD_WS]: "board" } }));
    await waitFor(() => expect(screen.getByRole("region", { name: "Getting started" }).className).not.toContain("ux-tour--lift"));
    // Paused in Code: no pill to raise.
    act(() => useUi.setState({ centerMode: { [BOARD_WS]: "code" } }));
    act(() => useTutorialRuntime.setState({ panelOpen: false }));
    await waitFor(() => expect(panel()).toBeNull());
    expect(document.querySelector(".ux-tour--lift, .ux-tour-pill")).toBeNull();
    expect(css).not.toContain(".ux-tour-pill");
    expect(rule(css, ".ux-tour--lift")).toContain("bottom: calc(var(--space-lg) + 28px)");
    expect(css).toMatch(/@media \(max-height: 820px\) \{\s*\.ux-tour \{ max-height: min\(var\(--ux-tour-cap, 100vh\), 50vh\); \}/);
    expect(rule(css, ".ux-tour-body")).toContain("overflow-y: auto");
    // The compact rules come after the base ones they override (same
    // specificity: an earlier media block loses to the later base rule).
    const media = css.indexOf("@media (max-height: 820px)");
    expect(media).toBeGreaterThan(css.indexOf("\n.ux-tour {"));
    expect(media).toBeGreaterThan(css.indexOf("\n.ux-tour-body {"));
  });
});

// ── TU-5 walk: the tour follows where you are until it has a card ────────
// A tour begun in Vega (TU-4's walks), the user now in Lyra (Setup's new
// project): Help › Getting started and ⋯ › Start over left B2 saying
// "This step is in Vega" with no coach-mark.

const VEGA = { ...boardWorkspace, id: "ws-vega", name: "Vega", cwd: "/Users/someone/code/vega" };

function seedTwo(tutorial: TutorialProgress | null, vegaCards: ReturnType<typeof boardCard>[] = []) {
  act(() => {
    useWorkspaces.setState({ workspaces: [boardWorkspace, VEGA], activeId: BOARD_WS, loaded: true });
    useKanban.setState({
      byWorkspace: { [BOARD_WS]: { cards: [], loaded: true }, [VEGA.id]: { cards: vegaCards, loaded: true } },
    });
    useSettings.setState({ settings: withTour(tutorial), loaded: true });
    useUi.setState({ centerMode: { [BOARD_WS]: "code", [VEGA.id]: "code" } });
  });
}

describe("the tour follows the active workspace until it has a card (TU-5 walk)", () => {
  it("Help › Getting started on a tour begun in Vega: B2 points at the Board row here", async () => {
    seedTwo(running({ workspaceId: VEGA.id, done: { [STEP.howItWorks]: T0 } }));
    const { user } = renderTour();
    await user.click(screen.getByRole("button", { name: "Help" }));
    await user.click(screen.getByRole("menuitem", { name: "Getting started" }));
    const region = await screen.findByRole("region", { name: "Getting started" });
    const coach = await screen.findByRole("dialog");
    expect(coach.textContent).toContain("Open the Board");
    expect(region.textContent).not.toContain("This step is in");
    expect(within(region).queryByRole("button", { name: "Take me there" })).toBeNull();
    await waitFor(() => expect(record()?.workspaceId ?? null).toBeNull());
  });

  it("⋯ › Start over from Lyra with a card under way in Vega: B1, then B2 here, not in Vega", async () => {
    const vegaCard = boardCard("v1", { workspaceId: VEGA.id, createdAt: Date.parse(T0) + 60_000 });
    seedTwo(running({ workspaceId: VEGA.id, cardId: "v1", done: { [STEP.howItWorks]: T0, [STEP.openBoard]: T0, [STEP.newCard]: T0 } }), [vegaCard]);
    act(() => useTutorialRuntime.setState({ panelOpen: true }));
    const { user } = renderTour();
    const region = await screen.findByRole("region", { name: "Getting started" });
    // The card's step says where it is before Start over.
    await waitFor(() => expect(region.textContent).toContain("This step is in Vega"));
    await user.click(within(region).getByRole("button", { name: "More for Getting started" }));
    await user.click(screen.getByRole("menuitem", { name: "Start over" }));
    await waitFor(() => expect(record()?.done).toEqual({}));
    expect(record()?.cardId ?? null).toBeNull();
    expect(record()?.workspaceId ?? null).toBeNull();
    await user.click(await within(region).findByRole("button", { name: "Start" }));
    const coach = await screen.findByRole("dialog");
    expect(coach.textContent).toContain("Open the Board");
    expect(region.textContent).not.toContain("This step is in");
  });
});
