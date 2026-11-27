// Getting started TU-8 (docs/tutorial/TUTORIAL_SPEC.md §3.3, §12.2, §13):
// Help's New in this version (the dot, the sheet, seen once opened), Get
// help (the report, the email, Copy) and Settings › Diagnostics › Copy
// tutorial report — rendered through the real stores.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TutorialProgress } from "../lib/settingsShape";
import { HelpMenu } from "../components/tutorial/HelpMenu";
import { HelpSheets } from "../components/tutorial/HelpSheets";
import { DiagnosticsPage } from "../components/settings/DiagnosticsPage";
import { resetHelpForTests, startHelp, useHelp } from "../store/helpStore";
import { CHANGELOG_URL, highlightsFor } from "../lib/releaseHighlights";
import { setPlatformForTests } from "../lib/platform";
import { useKanban } from "../store/kanbanStore";
import { endQuickTour, useQuickTour } from "../store/quickTourStore";
import { useToasts } from "../store/toastStore";
import { DEFAULT_SETTINGS, useSettings, type Settings } from "../store/settingsStore";
import { startTutorialSubscription, stopTutorialForTests } from "../store/tutorialStore";
import { useUi } from "../store/uiStore";
import { useWorkspaces } from "../store/workspaceStore";
import { BOARD_WS, boardCard, boardWorkspace } from "./boardFixtures";
import { act, renderUi, screen, waitFor, within } from "./render";

/** user-event puts its own clipboard on `navigator` when a test renders:
 *  watched after that. */
function watchClipboard() {
  return vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
}

afterEach(() => {
  resetHelpForTests();
  stopTutorialForTests();
});

/** `newInstall`: Setup's first run not done yet (no `firstRunCompletedAt`). */
function seed(opts: { tutorial?: TutorialProgress | null; shipped?: boolean; newInstall?: boolean } = {}) {
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    onboarding: {
      ...DEFAULT_SETTINGS.onboarding,
      firstRunCompletedAt: opts.newInstall ? null : "2026-09-01T00:00:00Z",
      level: "guided",
      tutorial: opts.tutorial ?? null,
    },
  };
  act(() => {
    useWorkspaces.setState({ workspaces: [boardWorkspace], activeId: BOARD_WS, loaded: true });
    useKanban.setState({
      byWorkspace: {
        [BOARD_WS]: {
          cards: [boardCard("Add a secret card title", opts.shipped ? { shipStatus: "shipped" } : {})],
          loaded: true,
        },
      },
    });
    useSettings.setState({ settings, loaded: true });
    useUi.setState({ centerMode: { [BOARD_WS]: "board" } });
  });
}

function renderHelp(trigger?: Parameters<typeof HelpMenu>[0]["trigger"], version = "1.167.0") {
  const view = renderUi(
    <>
      <button type="button" data-ply-tour="nav-board">
        Board
      </button>
      <HelpMenu trigger={trigger} />
      <HelpSheets />
    </>,
    {
      fixtures: {
        settings_set: ({ settings }: Record<string, unknown>) => settings,
        "plugin:app|version": version,
        open_support_mail: null,
        kanban_load: [],
      },
    },
  );
  view.tauri.allowUnhandled();
  startHelp();
  return view;
}

const record = () => useSettings.getState().settings.onboarding?.tutorial ?? null;
const dot = () => document.querySelector(".ux-more-dot");

async function openHelp(user: ReturnType<typeof renderHelp>["user"]) {
  await user.click(screen.getByRole("button", { name: "Help" }));
  return screen.getByRole("menu", { name: "Help" });
}

describe("Help (§3.3)", () => {
  it("lists every entry, in order", async () => {
    seed();
    const { user } = renderHelp();
    const menu = await openHelp(user);
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
      "Getting started",
      "Take a 1-minute tour",
      expect.stringContaining("New in this version"),
      expect.stringContaining("Keyboard shortcuts"),
      "User guide",
      // QoL 1.168 S3.
      "Check for updates…",
      "Get help",
    ]);
  });
});

describe("Help, a sidebar row (1.169.0, C9)", () => {
  it("is a row with its word, opens from the keyboard and gives focus back", async () => {
    seed();
    // The sidebar's trigger (WorkspaceSidebar), drawn from MoreMenu's props.
    const { user } = renderHelp(({ ref, props, label, dot }) => (
      <button ref={ref} type="button" className="shell-nav-item" {...props}>
        <span>{label}</span>
        {dot && <span className="ux-more-dot" aria-hidden="true" />}
      </button>
    ));
    const help = screen.getByRole("button", { name: "Help" });
    expect(help.classList.contains("shell-nav-item")).toBe(true);
    expect(help.parentElement?.classList.contains("ux-more--row")).toBe(true);
    expect(help.textContent).toBe("Help");
    // The New dot is on the row while something is unseen.
    await waitFor(() => expect(help.querySelector(".ux-more-dot")).not.toBeNull());
    help.focus();
    await user.keyboard("{Enter}");
    const menu = screen.getByRole("menu", { name: "Help" });
    expect(document.activeElement?.textContent).toBe("Getting started");
    expect(menu.parentElement?.contains(help)).toBe(true);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu", { name: "Help" })).toBeNull();
    expect(document.activeElement).toBe(help);
  });
});

describe("New in this version: each release's highlights (owner, 2026-10-21)", () => {
  it("an old user upgrading: the dot, this version's points, the tour from its point, the dot gone", async () => {
    seed();
    const { user } = renderHelp();
    await waitFor(() => expect(dot()).not.toBeNull());
    // Named Help still, described by what is new (§10's pattern).
    const help = screen.getByRole("button", { name: "Help" });
    expect(document.getElementById(help.getAttribute("aria-describedby")!)!.textContent).toBe(
      "Something new in this version",
    );
    const menu = await openHelp(user);
    expect(within(menu).getByRole("menuitem", { name: /New in this version/ }).textContent).toContain("New");
    await user.click(within(menu).getByRole("menuitem", { name: /New in this version/ }));
    const sheet = await screen.findByRole("dialog", { name: "New in this version" });
    // The installed version's entry (the fixture says 1.167.0), whatever the newest is.
    const now = highlightsFor("1.167.0")!;
    expect(sheet.textContent).toContain(`Plyloft ${now.version} · ${now.title}`);
    // F6: the newest title is a heading like the earlier ones, not the lede.
    const newest = within(sheet).getByRole("heading", { name: `Plyloft ${now.version} · ${now.title}` });
    expect(newest.classList.contains("ux-tour-note-title")).toBe(true);
    expect(sheet.querySelector(".ux-sheet-lede")).toBeNull();
    expect(sheet.querySelectorAll(`[data-ply-whats-new^="${now.version}:"]`)).toHaveLength(now.points.length);
    expect(within(sheet).getByRole("button", { name: "Full changelog" })).toBeTruthy();
    // 1.172.0 (owner, 2026-10-28): a point's press and Full changelog read as
    // buttons (bordered), never as quiet text that shows only under a hover.
    const presses = [...sheet.querySelectorAll(".ux-whats-new .cbtn")];
    expect(presses.length).toBeGreaterThan(0);
    for (const b of [...presses, within(sheet).getByRole("button", { name: "Full changelog" })]) {
      expect(b.classList.contains("cbtn--quiet")).toBe(false);
    }
    await waitFor(() => expect(record()?.seenVersion).toBe(now.version));
    await user.click(within(sheet).getByRole("button", { name: "Take a 1-minute tour" }));
    expect(useHelp.getState().whatsNew).toBeNull();
    expect(useQuickTour.getState().quick?.index).toBe(0);
    act(() => endQuickTour());
    expect(dot()).toBeNull();
  });

  it("opened again later: the same version's points, never an empty sheet", async () => {
    seed({ tutorial: { seenVersion: "1.167.0" } });
    const { user } = renderHelp();
    await waitFor(() => expect(useHelp.getState().version).toBe("1.167.0"));
    expect(dot()).toBeNull();
    await user.click(within(await openHelp(user)).getByRole("menuitem", { name: "New in this version" }));
    const sheet = await screen.findByRole("dialog", { name: "New in this version" });
    expect(sheet.querySelectorAll('[data-ply-whats-new^="1.167.0:"]').length).toBeGreaterThanOrEqual(3);
    expect(sheet.textContent).not.toContain("Since you last looked");
  });

  it("Full changelog opens the site's changelog; a point's place opens there", async () => {
    seed({ tutorial: { seenVersion: "1.167.0" } });
    const { user, tauri } = renderHelp();
    await waitFor(() => expect(useHelp.getState().version).toBe("1.167.0"));
    await user.click(within(await openHelp(user)).getByRole("menuitem", { name: "New in this version" }));
    let sheet = await screen.findByRole("dialog", { name: "New in this version" });
    await user.click(within(sheet).getByRole("button", { name: "Full changelog" }));
    await waitFor(() => expect(tauri.callsOf("open_web_link")).toHaveLength(1));
    expect(tauri.callsOf("open_web_link")[0].args).toEqual({ url: CHANGELOG_URL });
    sheet = screen.getByRole("dialog", { name: "New in this version" });
    await user.click(within(sheet).getByRole("button", { name: "Open All skills" }));
    expect(useHelp.getState().whatsNew).toBeNull();
    expect(useUi.getState().allSkillsOpen).toBe(true);
  });

  it("a new install is stamped before it is asked: no dot, the points still there", async () => {
    seed({ newInstall: true });
    const { user } = renderHelp();
    await waitFor(() => expect(record()?.seenVersion).toBe("1.167.0"));
    expect(dot()).toBeNull();
    await user.click(within(await openHelp(user)).getByRole("menuitem", { name: "New in this version" }));
    const sheet = await screen.findByRole("dialog", { name: "New in this version" });
    expect(sheet.querySelectorAll('[data-ply-whats-new^="1.167.0:"]').length).toBeGreaterThanOrEqual(3);
  });
});

describe("New in this version on Windows (1.174.0, TX7)", () => {
  afterEach(() => setPlatformForTests(null));

  it("a point's keys and this Mac read as Windows says them", async () => {
    setPlatformForTests("windows");
    seed({ tutorial: { seenVersion: "1.169.0" } });
    const { user } = renderHelp(undefined, "1.169.0");
    await waitFor(() => expect(useHelp.getState().version).toBe("1.169.0"));
    await user.click(within(await openHelp(user)).getByRole("menuitem", { name: "New in this version" }));
    const sheet = await screen.findByRole("dialog", { name: "New in this version" });
    expect(sheet.textContent).toContain("(Ctrl+Shift+7 on an Italian one)");
    expect(sheet.textContent).not.toContain("⌘");
  });

  it("1.174.0: the rename, Settings' groups and the areas kept on this PC", async () => {
    setPlatformForTests("windows");
    seed({ tutorial: { seenVersion: "1.174.0" } });
    const { user } = renderHelp(undefined, "1.174.0");
    await waitFor(() => expect(useHelp.getState().version).toBe("1.174.0"));
    await user.click(within(await openHelp(user)).getByRole("menuitem", { name: "New in this version" }));
    const sheet = await screen.findByRole("dialog", { name: "New in this version" });
    expect(sheet.querySelectorAll('[data-ply-whats-new^="1.174.0:"]')).toHaveLength(highlightsFor("1.174.0")!.points.length);
    expect(sheet.textContent).toContain("The Challenger is now called the Reviewer");
    expect(sheet.textContent).toContain("kept on this PC until you share it");
    expect(sheet.textContent).not.toContain("this Mac");
    expect(within(sheet).getByRole("button", { name: "Open AI and models" })).toBeTruthy();
  });
});

describe("Get help (§3.3, D23)", () => {
  it("the report with no names, an email to support through the backend, and Copy", async () => {
    seed({ tutorial: { startedAt: "2026-10-21T09:00:00.000Z", path: "full", workspaceId: BOARD_WS, cardId: "Add a secret card title" } });
    const { user, tauri } = renderHelp();
    // A tour under way on a card whose title is secret: the report names
    // where the tour is by step id only.
    startTutorialSubscription();
    const writeText = watchClipboard();
    await user.click(within(await openHelp(user)).getByRole("menuitem", { name: "Get help" }));
    const sheet = await screen.findByRole("dialog", { name: "Get help" });
    expect(sheet.textContent).toContain("No project names, code or text.");
    const report = sheet.querySelector("[data-ply-tutorial-report]")!.textContent!;
    expect(report).toContain("Plyloft tutorial report");
    expect(report).toContain("Where the tour is:");
    for (const secret of ["Lyra", "secret card", BOARD_WS, "/Users/"]) expect(report).not.toContain(secret);
    await user.click(within(sheet).getByRole("button", { name: "Copy the report" }));
    expect(writeText).toHaveBeenCalledWith(report);
    await user.click(within(sheet).getByRole("button", { name: "Email support" }));
    await waitFor(() => expect(tauri.callsOf("open_support_mail")).toHaveLength(1));
    const url = tauri.callsOf("open_support_mail")[0].args.url as string;
    expect(url).toMatch(/^mailto:support@plyloft\.com\?subject=/);
    const body = decodeURIComponent(url);
    expect(body).toMatch(/Steps: \d+ done, \d+ skipped/);
    expect(body).not.toContain("secret card");
    // The sheet stays, the address on it (a mail app may open on its own
    // setup screen).
    expect(screen.getByRole("dialog", { name: "Get help" }).textContent).toContain("support@plyloft.com");
  });

  it("the mail app didn't open: the sheet stays, with Copy", async () => {
    seed();
    const { user, tauri } = renderHelp();
    tauri.fixture("open_support_mail", () => Promise.reject(new Error("no handler")));
    await user.click(within(await openHelp(user)).getByRole("menuitem", { name: "Get help" }));
    const sheet = await screen.findByRole("dialog", { name: "Get help" });
    await user.click(within(sheet).getByRole("button", { name: "Email support" }));
    await waitFor(() =>
      expect(useToasts.getState().toasts.some((t) => t.title === "Your mail app didn't open")).toBe(true),
    );
    expect(screen.getByRole("dialog", { name: "Get help" })).toBeTruthy();
  });
});

describe("Settings › Diagnostics › Copy tutorial report (§13)", () => {
  it("copies the report, never a name", async () => {
    seed({ tutorial: { startedAt: "2026-10-21T09:00:00.000Z", path: "full", workspaceId: BOARD_WS } });
    const { user } = renderUi(<DiagnosticsPage scope="this-mac" />, {
      fixtures: { dependency_doctor: () => null, build_cache_status: () => null, project_try_command_get: () => null, worktree_settings_get: () => ({}) },
    });
    const writeText = watchClipboard();
    const row = (await screen.findByText("Copy tutorial report")).closest(".ux-row") as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const text = writeText.mock.calls[0][0] as string;
    expect(text).toContain("Plyloft tutorial report");
    expect(text).not.toContain(BOARD_WS);
    expect(text).not.toContain("Lyra");
  });
});

// QoL 1.168 S3: after an update, one quiet toast says so and opens New in
// this version; never twice for a version, never on a new install.
describe("Updated to (QoL 1.168 S3)", () => {
  it("says it once, and its action opens New in this version", async () => {
    localStorage.removeItem("ply.updateAnnounced");
    act(() => useToasts.setState({ toasts: [] }));
    seed({ tutorial: { seenVersion: "1.166.0" } });
    renderHelp();
    await waitFor(() =>
      expect(useToasts.getState().toasts.map((t) => t.title)).toContain("Updated to 1.167.0"),
    );
    const toast = useToasts.getState().toasts.find((t) => t.title === "Updated to 1.167.0")!;
    expect(toast.action?.label).toBe("What's new");
    act(() => toast.action!.onClick());
    expect(useHelp.getState().whatsNew?.current?.version).toBe("1.167.0");
    // A later launch of the same version says nothing.
    resetHelpForTests();
    act(() => useToasts.setState({ toasts: [] }));
    seed({ tutorial: { seenVersion: "1.166.0" } });
    startHelp();
    await waitFor(() => expect(useHelp.getState().version).toBe("1.167.0"));
    expect(useToasts.getState().toasts.map((t) => t.title)).not.toContain("Updated to 1.167.0");
  });

  // 1.168.1 (walk #12): a settings change toasts "Theme set to light…" over
  // it; Dismiss on that toast must leave nothing — the update notice never
  // comes back behind it (Help keeps the dot and New in this version).
  it("goes for good when a newer toast covers it, so Dismiss leaves nothing", async () => {
    localStorage.removeItem("ply.updateAnnounced");
    act(() => useToasts.setState({ toasts: [], queue: [] }));
    seed({ tutorial: { seenVersion: "1.166.0" } });
    renderHelp();
    await waitFor(() =>
      expect(useToasts.getState().toasts.map((t) => t.title)).toContain("Updated to 1.167.0"),
    );
    // Seen for a while first (DROP_COVERED_AFTER_MS): covered sooner, it
    // would be put back (toastActionStays.test.tsx).
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 10_000);
    let theme = "";
    act(() => {
      theme = useToasts.getState().push({ kind: "info", title: "Theme set to light on this Mac." });
    });
    expect(useToasts.getState().queue.map((t) => t.title)).not.toContain("Updated to 1.167.0");
    act(() => useToasts.getState().dismiss(theme));
    expect(useToasts.getState().toasts).toEqual([]);
    expect(useToasts.getState().queue).toEqual([]);
    clock.mockRestore();
  });

  it("is never shown on a new install", async () => {
    localStorage.removeItem("ply.updateAnnounced");
    act(() => useToasts.setState({ toasts: [] }));
    seed({ newInstall: true });
    renderHelp();
    await waitFor(() => expect(useHelp.getState().version).toBe("1.167.0"));
    expect(useToasts.getState().toasts.map((t) => t.title)).not.toContain("Updated to 1.167.0");
  });
});
