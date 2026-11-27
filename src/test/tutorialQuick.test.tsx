// Getting started TU-6 (docs/tutorial/TUTORIAL_SPEC.md §6.4, §6.5, §3.3,
// §10): the Quick tour and the first-visit tips, rendered through the real
// stores, the tour's real subscriptions and the Help menu.
//
// - Help › Take a 1-minute tour: nine explain-only marks with Next, the
//   page moved only through the tour's helpers, a control not on screen
//   shown docked, Done on the last; back where the member started, the
//   keyboard on Help. No full tour is started; the sections it showed are
//   seen. Close and Esc end it too. The full tour's panel stands aside.
// - A tip shows when a section is opened (never the one the app opened on),
//   once, with Got it; not on "just the essentials" unless Help's switch is
//   on; never while a tour is under way.
import { useState, type ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { TutorialProgress } from "../lib/settingsShape";
import { HelpMenu, TutorialStatusRow } from "../components/tutorial/HelpMenu";
import { QuickTourLayer } from "../components/tutorial/QuickTourLayer";
import { TutorialLayer } from "../components/tutorial/TutorialLayer";
import { useKanban } from "../store/kanbanStore";
import { startTourTipsSubscription, stopQuickTourForTests, useQuickTour } from "../store/quickTourStore";
import { DEFAULT_SETTINGS, useSettings, type Settings } from "../store/settingsStore";
import {
  startGuideFromSetup,
  startTutorialSubscription,
  stopTutorialForTests,
  useTutorialRuntime,
} from "../store/tutorialStore";
import { openCenterMode, useUi, type CenterMode } from "../store/uiStore";
import { useWorkMode } from "../store/workModeStore";
import { useWorkspaces } from "../store/workspaceStore";
import { MoreMenu, SplitButton } from "../components/ux/MoreMenu";
import { Popover } from "../components/ux/Screen";
import { BOARD_WS, boardCard, boardWorkspace } from "./boardFixtures";
import { act, renderUi, screen, waitFor, within } from "./render";

afterEach(() => {
  stopQuickTourForTests();
  stopTutorialForTests();
  useWorkMode.setState({ mode: null, chosen: false });
});

const T0 = "2026-10-21T09:00:00.000Z";

function seed(opts: {
  tutorial?: TutorialProgress | null;
  level?: "guided" | "fast" | null;
  mode?: CenterMode;
  cards?: ReturnType<typeof boardCard>[];
  workMode?: "solo" | "team" | null;
}) {
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    onboarding: { ...DEFAULT_SETTINGS.onboarding, level: opts.level ?? null, tutorial: opts.tutorial ?? null },
  };
  act(() => {
    useWorkspaces.setState({ workspaces: [boardWorkspace], activeId: BOARD_WS, loaded: true });
    useKanban.setState({ byWorkspace: { [BOARD_WS]: { cards: opts.cards ?? [], loaded: true } } });
    useSettings.setState({ settings, loaded: true });
    useUi.setState({ centerMode: { [BOARD_WS]: opts.mode ?? "code" }, selectedCardId: {}, allSkillsOpen: false });
    const workMode = opts.workMode === undefined ? "solo" : opts.workMode;
    useWorkMode.setState({ mode: workMode, chosen: workMode != null });
  });
}

/** Stand-ins for the controls the marks point at (the real ones are
 *  rendered by the coverage test). `ship-batch` is left out: that row shows
 *  only while there is something to ship. */
const ANCHORS = ["nav-board", "card-primary", "board-new-card", "terminals-new", "code-more", "library-tabs", "nav-inbox", "nav-history", "nav-all-skills"];

function renderQuick(page?: ReactNode) {
  // A page of its own draws its own card-primary (the real Start build ▾).
  const stand = page ? ANCHORS.filter((a) => a !== "card-primary") : ANCHORS;
  const view = renderUi(
    <>
      {page}
      {stand.map((a) => (
        <button key={a} type="button" data-ply-tour={a}>
          {a}
        </button>
      ))}
      <button type="button">Elsewhere</button>
      <TutorialStatusRow />
      <HelpMenu />
      <TutorialLayer covered={false} />
      <QuickTourLayer covered={false} />
    </>,
    {
      fixtures: {
        settings_set: ({ settings }: Record<string, unknown>) => settings,
        "plugin:app|version": "1.168.0",
        fs_list_dir: [],
        "plugin:log|log": null,
      },
    },
  );
  view.tauri.allowUnhandled();
  startTutorialSubscription();
  startTourTipsSubscription();
  return view;
}

const record = () => useSettings.getState().settings.onboarding?.tutorial ?? null;
const mode = () => useUi.getState().centerMode[BOARD_WS];
const coach = () => screen.getByRole("dialog");
const tour = (anchor: string) => document.querySelector(`[data-ply-tour="${anchor}"]`) as HTMLElement;

async function startFromHelp(user: ReturnType<typeof renderQuick>["user"]) {
  await user.click(screen.getByRole("button", { name: "Help" }));
  await user.click(screen.getByRole("menuitem", { name: "Take a 1-minute tour" }));
}

describe("Help › Take a 1-minute tour (§6.4)", () => {
  it("nine marks with Next, the page moved by the tour, Done back where it started", async () => {
    seed({ cards: [boardCard("old"), boardCard("newest")] });
    const { user } = renderQuick();
    await startFromHelp(user);

    // 1: the Board row; Next has the keyboard (the one thing to do).
    await waitFor(() => expect(coach().textContent).toContain("Step 1 of 9 · The Board row"));
    expect(coach().getAttribute("aria-modal")).toBe("false");
    await waitFor(() => expect(document.activeElement).toBe(within(coach()).getByRole("button", { name: "Next" })));
    expect(mode()).toBe("board");
    expect(tour("nav-board").getAttribute("aria-describedby")).toBe(coach().getAttribute("aria-describedby"));
    // Said once, by the focus moving into the mark: no live region for it.
    expect(document.querySelector('[aria-live="polite"]')!.textContent).toBe("");

    // 2: the newest card's page.
    await user.click(within(coach()).getByRole("button", { name: "Next" }));
    await waitFor(() => expect(coach().textContent).toContain("A card's page"));
    expect(useUi.getState().selectedCardId[BOARD_WS]).toBe("newest");

    // 3–5: Terminals, Code, the Library — the card put back first.
    const expectMode = [
      ["Terminals", "terminals"],
      ["Code", "code"],
      ["The Library", "library"],
    ] as const;
    for (const [title, m] of expectMode) {
      await user.click(within(coach()).getByRole("button", { name: "Next" }));
      await waitFor(() => expect(coach().querySelector(".ux-tour-coach-title")!.textContent).toBe(title));
      expect(mode()).toBe(m);
      expect(useUi.getState().selectedCardId[BOARD_WS] ?? null).toBeNull();
    }
    // 6, 7: Inbox and All skills point at their rows, the page stays.
    for (const title of ["Inbox", "All skills"]) {
      await user.click(within(coach()).getByRole("button", { name: "Next" }));
      await waitFor(() => expect(coach().querySelector(".ux-tour-coach-title")!.textContent).toBe(title));
      expect(mode()).toBe("library");
    }
    // 8: nothing to ship — the row isn't there; the words dock instead.
    await user.click(within(coach()).getByRole("button", { name: "Next" }));
    await waitFor(() => expect(coach().textContent).toContain("Release a version"));
    expect(coach().textContent).toContain("Step 8 of 9");
    expect(coach().classList.contains("ux-tour--quick")).toBe(true);
    await waitFor(() => expect(document.activeElement).toBe(within(coach()).getByRole("button", { name: "Next" })));

    // 9: Help, Done and no Close.
    await user.click(within(coach()).getByRole("button", { name: "Next" }));
    await waitFor(() => expect(coach().textContent).toContain("The full tour is in Help › Getting started."));
    expect(within(coach()).queryByRole("button", { name: "Close" })).toBeNull();
    await user.click(within(coach()).getByRole("button", { name: "Done" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(useQuickTour.getState().quick).toBeNull();
    // Back where it started: Code, no card open; the keyboard on Help.
    expect(mode()).toBe("code");
    expect(useUi.getState().selectedCardId[BOARD_WS] ?? null).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Help" })));
    // The record: only that it was the Quick tour, and the sections shown.
    await waitFor(() => expect(record()?.path).toBe("quick"));
    expect(record()?.startedAt ?? null).toBeNull();
    expect([...(record()?.seenSections ?? [])].sort()).toEqual(["all-skills", "code", "inbox", "library", "terminals"]);
  });

  it("no card yet: the second mark is the Board's New card", async () => {
    seed({});
    const { user } = renderQuick();
    await startFromHelp(user);
    await user.click(await within(await screen.findByRole("dialog")).findByRole("button", { name: "Next" }));
    await waitFor(() => expect(coach().textContent).toContain("Step 2 of 9 · The New card button"));
    expect(mode()).toBe("board");
  });

  it("a team gets the team's mark after the Library; an unknown mode too (OB-9)", async () => {
    for (const workMode of ["team", null] as const) {
      seed({ workMode });
      const { user, unmount } = renderQuick();
      await startFromHelp(user);
      await waitFor(() => expect(coach().textContent).toContain("Step 1 of 10"));
      for (let i = 0; i < 5; i += 1) await user.click(within(coach()).getByRole("button", { name: "Next" }));
      await waitFor(() => expect(coach().querySelector(".ux-tour-coach-title")!.textContent).toBe("Your team"));
      await user.click(within(coach()).getByRole("button", { name: "Close" }));
      unmount();
      stopQuickTourForTests();
      stopTutorialForTests();
    }
  });

  it("Close ends it and puts the page back; Esc ends it too", async () => {
    seed({ mode: "inbox" });
    const { user } = renderQuick();
    await startFromHelp(user);
    await user.click(await within(await screen.findByRole("dialog")).findByRole("button", { name: "Next" }));
    await waitFor(() => expect(mode()).toBe("board"));
    await user.click(within(coach()).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(useQuickTour.getState().quick).toBeNull());
    expect(mode()).toBe("inbox");

    await startFromHelp(user);
    await waitFor(() => expect(document.activeElement).toBe(within(coach()).getByRole("button", { name: "Next" })));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(useQuickTour.getState().quick).toBeNull());
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("went somewhere of their own meanwhile: the tour leaves them there", async () => {
    seed({});
    const { user } = renderQuick();
    await startFromHelp(user);
    await screen.findByRole("dialog");
    act(() => openCenterMode(BOARD_WS, "activity"));
    await user.click(within(coach()).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(useQuickTour.getState().quick).toBeNull());
    expect(mode()).toBe("activity");
  });

  it("the full tour's panel stands aside while it runs, and comes back; nothing of it is marked", async () => {
    seed({ tutorial: { startedAt: T0, path: "full", workspaceId: BOARD_WS, paused: false } });
    act(() => useTutorialRuntime.setState({ panelOpen: true }));
    const { user } = renderQuick();
    expect(await screen.findByRole("region", { name: "Getting started" })).toBeTruthy();
    await startFromHelp(user);
    await waitFor(() => expect(screen.queryByRole("region", { name: "Getting started" })).toBeNull());
    // The Board mark opens the Board: not B2 done (the tour moved there).
    await waitFor(() => expect(mode()).toBe("board"));
    await user.click(within(coach()).getByRole("button", { name: "Close" }));
    expect(await screen.findByRole("region", { name: "Getting started" })).toBeTruthy();
    expect(record()?.done?.["base.open-board"]).toBeUndefined();
    expect(record()?.startedAt).toBe(T0);
  });
});

describe("Reviewer round 1", () => {
  it("the full tour's record in another project: the marks move the project on screen", async () => {
    seed({ tutorial: { startedAt: T0, endedAt: T0, path: "full", workspaceId: "ws-other" } });
    act(() => {
      useWorkspaces.setState({ workspaces: [boardWorkspace, { ...boardWorkspace, id: "ws-other", name: "Vega" }] });
      useUi.setState({ centerMode: { [BOARD_WS]: "code", "ws-other": "inbox" } });
    });
    const { user } = renderQuick();
    await startFromHelp(user);
    await screen.findByRole("dialog");
    await user.click(within(coach()).getByRole("button", { name: "Next" }));
    await user.click(within(coach()).getByRole("button", { name: "Next" }));
    await waitFor(() => expect(coach().querySelector(".ux-tour-coach-title")!.textContent).toBe("Terminals"));
    expect(mode()).toBe("terminals");
    expect(useUi.getState().centerMode["ws-other"]).toBe("inbox");
  });

  it("a modal opened mid-tour: the mark stands aside and keeps off its keyboard, then comes back", async () => {
    seed({});
    const { user } = renderQuick();
    await startFromHelp(user);
    await screen.findByRole("dialog");
    const modal = document.createElement("div");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.innerHTML = '<input aria-label="Search" />';
    act(() => {
      document.body.appendChild(modal);
    });
    const search = screen.getByRole("textbox", { name: "Search" });
    search.focus();
    await waitFor(() => expect(document.querySelector("[data-ply-tour-coach]")).toBeNull());
    await new Promise((r) => setTimeout(r, 500));
    expect(document.querySelector("[data-ply-tour-coach]")).toBeNull();
    expect(document.activeElement).toBe(search);
    act(() => modal.remove());
    await waitFor(() => expect(document.querySelector("[data-ply-tour-coach]")).not.toBeNull());
    expect(useQuickTour.getState().quick?.index).toBe(0);
  });

  it("walk 2026-10-27 step 5: a card's ⋯, Start build ▾, Ship it ▾, Finish and check ▾ or a picker open — the mark and its ring step aside, and come back on close", async () => {
    const items = [{ label: "Plan with two AIs…", onSelect: () => {} }, { label: "Archive", onSelect: () => {} }];
    function Picker() {
      const [open, setOpen] = useState(false);
      return (
        <Popover
          open={open}
          onClose={() => setOpen(false)}
          label="Choose the Builder"
          trigger={
            <button type="button" onClick={() => setOpen((o) => !o)}>
              Builder picker
            </button>
          }
        >
          <p>Claude or Codex</p>
        </Popover>
      );
    }
    const page = (
      <div>
        <SplitButton label="Start build" onClick={() => {}} items={items} menuLabel="More ways to start" mainProps={{ "data-ply-tour": "card-primary" }} />
        <SplitButton label="Ship it" onClick={() => {}} items={items} menuLabel="More ways to ship" />
        <SplitButton label="Finish and check" onClick={() => {}} items={items} menuLabel="More ways to finish" />
        <MoreMenu items={items} label="More for this card" />
        <Picker />
      </div>
    );
    seed({ cards: [boardCard("newest")] });
    const { user } = renderQuick(page);
    await startFromHelp(user);
    await waitFor(() => expect(coach().textContent).toContain("Step 1 of 9"));
    await user.click(within(coach()).getByRole("button", { name: "Next" }));
    await waitFor(() => expect(coach().textContent).toContain("A card's page"));
    const mark = () => document.querySelector("[data-ply-tour-coach]");
    for (const opener of ["More ways to start", "More ways to ship", "More ways to finish", "More for this card", "Builder picker"]) {
      await user.click(screen.getByRole("button", { name: opener }));
      await waitFor(() => expect(mark()).toBeNull());
      // Nothing of the tour is left over the menu: no ring, no dialog.
      expect(document.querySelector(".ux-tour-ring")).toBeNull();
      expect(screen.queryByRole("dialog", { name: "A card's page" })).toBeNull();
      // Closed (a press elsewhere): the same mark comes back.
      await user.click(screen.getByRole("button", { name: "Elsewhere" }));
      await waitFor(() => expect(mark()).not.toBeNull());
      expect(coach().textContent).toContain("A card's page");
      expect(useQuickTour.getState().quick?.index).toBe(1);
    }
  });

  it("a page that takes the keyboard a frame after the mark shows gives it back to Next", async () => {
    seed({});
    const { user } = renderQuick();
    await startFromHelp(user);
    await screen.findByRole("dialog");
    // As a card's page focuses its headline when it first opens.
    act(() => screen.getByRole("button", { name: "Elsewhere" }).focus());
    await waitFor(() => expect(document.activeElement).toBe(within(coach()).getByRole("button", { name: "Next" })));
  });

  it("Resume on the sidebar row ends the Quick tour and opens the panel", async () => {
    seed({ tutorial: { startedAt: T0, path: "full", workspaceId: BOARD_WS, paused: true } });
    const { user } = renderQuick();
    await startFromHelp(user);
    await screen.findByRole("dialog");
    await user.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(useQuickTour.getState().quick).toBeNull());
    expect(await screen.findByRole("region", { name: "Getting started" })).toBeTruthy();
  });

  it("Setup's Start the tour ends the Quick tour too", async () => {
    seed({});
    const { user } = renderQuick();
    await startFromHelp(user);
    await screen.findByRole("dialog");
    await act(async () => {
      await startGuideFromSetup();
    });
    expect(useQuickTour.getState().quick).toBeNull();
    expect(await screen.findByRole("region", { name: "Getting started" })).toBeTruthy();
  });

  it("Done puts History back: no History tip for it (nobody opened it)", async () => {
    seed({ level: "guided", mode: "activity" });
    const { user } = renderQuick();
    await startFromHelp(user);
    await screen.findByRole("dialog");
    // Mark 8 docks after a moment: each Next waits for its mark.
    for (let i = 0; i < 8; i += 1) {
      await user.click(await within(await screen.findByRole("dialog")).findByRole("button", { name: "Next" }));
    }
    await waitFor(() => expect(within(coach()).getByRole("button", { name: "Done" })).toBeTruthy());
    await user.click(within(coach()).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(useQuickTour.getState().quick).toBeNull());
    expect(mode()).toBe("activity");
    await new Promise((r) => setTimeout(r, 50));
    expect(useQuickTour.getState().tip).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Esc leaves the page as it is, the keyboard on the control", async () => {
    seed({ mode: "inbox" });
    const { user } = renderQuick();
    await startFromHelp(user);
    await screen.findByRole("dialog");
    await user.click(within(coach()).getByRole("button", { name: "Next" }));
    await user.click(within(coach()).getByRole("button", { name: "Next" }));
    await waitFor(() => expect(mode()).toBe("terminals"));
    await waitFor(() => expect(document.activeElement).toBe(within(coach()).getByRole("button", { name: "Next" })));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(useQuickTour.getState().quick).toBeNull());
    expect(mode()).toBe("terminals");
    expect(document.activeElement).toBe(tour("terminals-new"));
  });

  it("started again while it runs: back to where the member first was", async () => {
    seed({ mode: "inbox" });
    const { user } = renderQuick();
    await startFromHelp(user);
    await screen.findByRole("dialog");
    for (let i = 0; i < 3; i += 1) await user.click(within(coach()).getByRole("button", { name: "Next" }));
    await waitFor(() => expect(mode()).toBe("code"));
    await startFromHelp(user);
    await waitFor(() => expect(coach().textContent).toContain("Step 1 of 9"));
    await user.click(within(coach()).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(useQuickTour.getState().quick).toBeNull());
    expect(mode()).toBe("inbox");
  });
});

describe("first-visit tips (§6.5)", () => {
  it("step by step: a section opened shows its tip once, with Got it; not the one the app opened on", async () => {
    seed({ level: "guided", mode: "terminals" });
    const { user } = renderQuick();
    // The app opened on Terminals: nobody opened it.
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => openCenterMode(BOARD_WS, "board"));
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => openCenterMode(BOARD_WS, "terminals"));
    await waitFor(() => expect(coach().textContent).toContain("Terminals"));
    // Not counted, never a step of a tour; the keyboard stays where it was.
    expect(coach().textContent).not.toContain("Step");
    expect(within(coach()).queryByRole("button", { name: "Skip this step" })).toBeNull();
    expect(document.activeElement).not.toBe(within(coach()).getByRole("button", { name: "Got it" }));
    await waitFor(() => expect(record()?.seenSections).toEqual(["terminals"]));
    await user.click(within(coach()).getByRole("button", { name: "Got it" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(tour("terminals-new"));
    // Once: back to Terminals later, no tip.
    act(() => openCenterMode(BOARD_WS, "board"));
    act(() => openCenterMode(BOARD_WS, "terminals"));
    expect(screen.queryByRole("dialog")).toBeNull();
    // History has its own.
    act(() => openCenterMode(BOARD_WS, "activity"));
    await waitFor(() => expect(coach().textContent).toContain("Cards you've shipped, with what changed."));
  });

  it("just the essentials: none, until Help's switch turns them on", async () => {
    seed({ level: "fast", mode: "board" });
    const { user } = renderQuick();
    act(() => openCenterMode(BOARD_WS, "code"));
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Help" }));
    const toggle = screen.getByRole("menuitemcheckbox", { name: "Tips when I open a section" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await user.click(toggle);
    await waitFor(() => expect(record()?.tips).toBe(true));
    await user.keyboard("{Escape}");
    act(() => openCenterMode(BOARD_WS, "library"));
    await waitFor(() => expect(coach().textContent).toContain("The Library"));
  });

  it("step by step: the switch shows on; turned off, the tip on screen goes", async () => {
    seed({ level: "guided", mode: "board" });
    const { user } = renderQuick();
    act(() => openCenterMode(BOARD_WS, "code"));
    await waitFor(() => expect(coach().textContent).toContain("Code"));
    await user.click(screen.getByRole("button", { name: "Help" }));
    const toggle = screen.getByRole("menuitemcheckbox", { name: "Tips when I open a section" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await user.click(toggle);
    await waitFor(() => expect(record()?.tips).toBe(false));
    expect(document.querySelector("[data-ply-tour-coach]")).toBeNull();
    await user.keyboard("{Escape}");
    act(() => openCenterMode(BOARD_WS, "library"));
    expect(document.querySelector("[data-ply-tour-coach]")).toBeNull();
  });

  it("a tip is said politely, without taking the keyboard", async () => {
    seed({ level: "guided", mode: "board" });
    renderQuick();
    act(() => openCenterMode(BOARD_WS, "inbox"));
    await waitFor(() =>
      expect(document.querySelector('[aria-live="polite"]')?.textContent ?? "").toContain("Inbox. Everything waiting for you"),
    );
  });

  it("Help › Getting started puts away a tip on screen (one guide at a time)", async () => {
    seed({ level: "guided", mode: "board" });
    const { user } = renderQuick();
    act(() => openCenterMode(BOARD_WS, "terminals"));
    await waitFor(() => expect(document.querySelector("[data-ply-tour-coach]")).not.toBeNull());
    await user.click(screen.getByRole("button", { name: "Help" }));
    await user.click(screen.getByRole("menuitem", { name: "Getting started" }));
    expect(await screen.findByRole("region", { name: "Getting started" })).toBeTruthy();
    expect(useQuickTour.getState().tip).toBeNull();
    expect(document.querySelector('[data-ply-tour-coach="terminals-new"]')).toBeNull();
  });

  it("never while a tour is under way", async () => {
    seed({ level: "guided", mode: "board", tutorial: { startedAt: T0, path: "full", workspaceId: BOARD_WS, paused: true } });
    renderQuick();
    act(() => openCenterMode(BOARD_WS, "code"));
    await waitFor(() => expect(useQuickTour.getState().tip).toBeNull());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(record()?.seenSections ?? []).toEqual([]);
  });
});
