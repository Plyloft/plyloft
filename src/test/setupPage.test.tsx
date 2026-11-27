// OB-15 (onboarding §9.2, §3.3): Settings › Account › Setup — Setup's state
// and `Open setup`, each required item with `Fix`, How setup explains things,
// Work with a team (OB-9), Projects folder with `Change…` (tilde form, and the
// team's clone root kept first when team workspaces are already cloned), and
// GitHub accounts — and ⌘K's "Open setup".
import { describe, expect, it } from "vitest";
import { within } from "@testing-library/react";
import { SettingsOverlay } from "../components/SettingsOverlay";
import { CommandPalette } from "../components/CommandPalette";
import type { DoctorReport, GithubStatus, ToolStatus } from "../ipc";
import { DEFAULT_SETTINGS, useSettings, type Settings } from "../store/settingsStore";
import { useDoctor } from "../store/doctorStore";
import { useSetup } from "../store/setupStore";
import { useUi } from "../store/uiStore";
import { useWorkMode } from "../store/workModeStore";
import { useWorkspaces, type Workspace } from "../store/workspaceStore";
import { endQuickTour, useQuickTour } from "../store/quickTourStore";
import { act, nextFrame, renderUi, screen, tauri, waitFor } from "./render";

const lyra: Workspace = {
  id: "l",
  name: "Lyra",
  cwd: "/Users/ann/code/lyra",
  createdAt: 1,
  lastOpenedAt: 1,
  openFiles: [],
  activeFile: null,
};

function tool(id: string, found: boolean): ToolStatus {
  return { id, name: id, required: id === "git", found, versionOk: found } as unknown as ToolStatus;
}

function report(ai: boolean): DoctorReport {
  return {
    tools: [tool("git", true), tool("claude", ai)],
    allRequiredOk: ai,
    aiReady: ai,
    gitWorks: true,
    gitIdentity: { name: "Ann", email: "ann@example.com" },
  } as unknown as DoctorReport;
}

const GITHUB: GithubStatus = {
  ghFound: true,
  accounts: [
    { login: "ann", active: true, state: "signed-in", scopes: "repo, read:org" },
    { login: "ann-work", active: false, state: "signed-in", scopes: "repo, read:org" },
  ],
  helper: "gh",
  githubEmail: null,
  githubNoreply: null,
  sso: null,
};

/** The backend as far as this page goes: `settings_set` keeps what was saved,
 *  in the order it was saved. */
function seed({
  settings = DEFAULT_SETTINGS,
  ai = false,
  configured = ["l"],
  team = null as unknown,
}: { settings?: Settings; ai?: boolean; configured?: string[]; team?: unknown } = {}) {
  tauri().allowUnhandled();
  let saved: Settings = settings;
  const writes: Settings[] = [];
  tauri().fixture("settings_get", () => saved);
  tauri().fixture("settings_set", ({ settings: next }: Record<string, unknown>) => {
    saved = next as Settings;
    writes.push(saved);
    return saved;
  });
  tauri().fixture("team_work_mode", () => ({ mode: saved.team?.workMode ?? "solo", chosen: saved.team?.workMode != null }));
  tauri().fixture("project_config_list", () => configured.map((id) => [id, {}]));
  tauri().fixture("setup_github_status", GITHUB);
  tauri().fixture("dependency_doctor", report(ai));
  if (team) tauri().fixture("team_status", team);
  act(() => {
    useSettings.setState({ settings: saved, loaded: true } as never);
    useWorkspaces.setState({ loaded: true, workspaces: [lyra], activeId: "l" });
    useDoctor.setState({ report: report(ai) });
  });
  return { saved: () => saved, writes };
}

async function openSetupPage() {
  const r = renderUi(<SettingsOverlay />);
  act(() => useUi.getState().setSettingsOverlayOpen(true));
  act(() => useUi.getState().openSettingsSection("setup"));
  await screen.findByRole("navigation", { name: "Settings sections" });
  await screen.findByText("How setup explains things");
  return r;
}

/** A row by its label: the `.ux-row` holding it. */
function row(label: string): HTMLElement {
  const el = screen
    .getAllByText(label)
    .map((n) => n.closest(".ux-row") as HTMLElement | null)
    .find((n) => n !== null);
  if (!el) throw new Error(`no row "${label}"`);
  return el;
}

describe("Settings › Account › Setup", () => {
  it("says how far Setup is, and Open setup opens it as a rerun", async () => {
    seed();
    const r = await openSetupPage();
    await waitFor(() => expect(within(row("Setup")).getByText(/of \d+ steps done\./)).toBeTruthy());
    await r.user.click(within(row("Setup")).getByRole("button", { name: "Open setup" }));
    expect(useSetup.getState()).toMatchObject({ open: true, setupCase: "rerun", step: null });
  });

  it("says Done. once every required item is there", async () => {
    seed({ ai: true });
    await openSetupPage();
    await waitFor(() => expect(within(row("Setup")).getByText("Done.")).toBeTruthy());
    // Nothing missing: no Fix anywhere.
    expect(screen.queryByRole("button", { name: /^Fix in Setup/ })).toBeNull();
  });

  it("lists each required item with its state, and Fix opens its step", async () => {
    seed({ ai: false, configured: [] });
    const r = await openSetupPage();
    await waitFor(() => expect(within(row("An AI tool")).getByText("Not installed")).toBeTruthy());
    expect(within(row("Git")).getByText("Works")).toBeTruthy();
    expect(within(row("Your name and email")).getByText("Set")).toBeTruthy();
    expect(within(row("A first project")).getByText("Not set up for builds")).toBeTruthy();
    // Only the missing ones carry Fix.
    expect(within(row("Git")).queryByRole("button")).toBeNull();
    await r.user.click(screen.getByRole("button", { name: "Fix in Setup: An AI tool" }));
    expect(useSetup.getState()).toMatchObject({ open: true, step: "ai" });
    act(() => useSetup.getState().closeSetup());
    await r.user.click(screen.getByRole("button", { name: "Fix in Setup: A first project" }));
    expect(useSetup.getState().step).toBe("config");
  });

  it("offers the guided first card (OB-16, §14): disabled with what is missing", async () => {
    seed({ ai: false, configured: [] });
    await openSetupPage();
    await waitFor(() =>
      expect(within(row("Guided first card")).getByText(
        "First, install an AI tool and set up your project's builds.",
      )).toBeTruthy(),
    );
    const button = within(row("Guided first card")).getByRole("button", { name: "Try a guided first card" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("the guided first card, once AI and the project are ready, makes the card and opens it", async () => {
    seed({ ai: true });
    tauri().fixture("kanban_load", []);
    tauri().fixture("kanban_card_create", (args: Record<string, unknown>) => ({
      id: args.cardId,
      workspaceId: args.workspaceId,
      title: args.title,
      notes: args.notes,
      columnId: args.columnId,
      createdAt: 1,
      updatedAt: 1,
    }));
    tauri().fixture("workspace_set_active", null);
    const again = await openSetupPage();
    const start = within(row("Guided first card")).getByRole("button", { name: "Try a guided first card" });
    await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false));
    await again.user.click(start);
    await waitFor(() => expect(useUi.getState().settingsOverlayOpen).toBe(false));
    const created = tauri().callsOf("kanban_card_create");
    expect(created[0].args).toMatchObject({ workspaceId: "l", title: "Describe this project in the README" });
    expect(useSettings.getState().settings.onboarding.firstCard?.cardId).toBe(created[0].args.cardId);
    expect(useUi.getState().selectedCardId.l).toBe(created[0].args.cardId);
  });

  it("changes how setup explains things", async () => {
    const b = seed();
    const r = await openSetupPage();
    const group = screen.getByRole("group", { name: "How setup explains things" });
    // Unset reads as step by step.
    expect(within(group).getByRole("button", { name: "Step by step" }).getAttribute("aria-pressed")).toBe("true");
    await r.user.click(within(group).getByRole("button", { name: "Just the essentials" }));
    await waitFor(() => expect(b.saved().onboarding.level).toBe("fast"));
  });

  it("keeps Work with a team (OB-9)", async () => {
    seed({ settings: { ...DEFAULT_SETTINGS, team: { ...DEFAULT_SETTINGS.team, workMode: "team" } } });
    await act(async () => useWorkMode.getState().refresh());
    await openSetupPage();
    expect(screen.getByRole("switch", { name: "Work with a team" }).getAttribute("aria-checked")).toBe("true");
  });

  it("shows ~/Projects until a folder is chosen, and Change… stores the pick in tilde form", async () => {
    const b = seed({ team: { teamRepo: null, hasClone: false, error: null, workspaces: [] } });
    tauri().fixture("plugin:path|resolve_directory", "/Users/ann");
    tauri().fixture("plugin:dialog|open", "/Users/ann/Work/Projects");
    const r = await openSetupPage();
    expect(within(row("Projects folder")).getByText("~/Projects")).toBeTruthy();
    await r.user.click(within(row("Projects folder")).getByRole("button", { name: "Change…" }));
    await waitFor(() => expect(b.saved().projects.folder).toBe("~/Work/Projects"));
    // No team workspaces to keep: the clone root is left alone.
    expect(b.saved().team.cloneRoot).toBeNull();
    await waitFor(() => expect(within(row("Projects folder")).getByText("~/Work/Projects")).toBeTruthy());
    // The picker opened where the folder is now.
    expect(tauri().callsOf("plugin:dialog|open")[0].args).toMatchObject({
      options: { directory: true, defaultPath: "/Users/ann/Projects" },
    });
  });

  it("keeps ~/code as the team's clone root first when team workspaces are cloned there", async () => {
    const b = seed({
      team: { teamRepo: "acme/team", hasClone: true, error: null, workspaces: [{ cloned: true, registered: true }] },
    });
    tauri().fixture("plugin:path|resolve_directory", "/Users/ann");
    tauri().fixture("plugin:dialog|open", "/Users/ann/Projects");
    const r = await openSetupPage();
    await r.user.click(within(row("Projects folder")).getByRole("button", { name: "Change…" }));
    await waitFor(() => expect(b.saved().projects.folder).toBe("~/Projects"));
    expect(b.saved().team.cloneRoot).toBe("~/code");
    // The clone root was written before the folder, never after it.
    const first = b.writes.findIndex((s) => s.team.cloneRoot === "~/code");
    const folder = b.writes.findIndex((s) => s.projects.folder === "~/Projects");
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(folder);
    expect(b.writes[first].projects.folder ?? null).toBeNull();
  });

  it("keeps ~/code in team mode when the team's manifest couldn't be read", async () => {
    const b = seed({
      settings: { ...DEFAULT_SETTINGS, team: { ...DEFAULT_SETTINGS.team, workMode: "team" } },
      team: { teamRepo: "acme/team", hasClone: true, error: "GitHub unreachable", workspaces: [] },
    });
    await act(async () => useWorkMode.getState().refresh());
    tauri().fixture("plugin:path|resolve_directory", "/Users/ann");
    tauri().fixture("plugin:dialog|open", "/Users/ann/Projects");
    const r = await openSetupPage();
    await r.user.click(within(row("Projects folder")).getByRole("button", { name: "Change…" }));
    await waitFor(() => expect(b.saved().projects.folder).toBe("~/Projects"));
    expect(b.saved().team.cloneRoot).toBe("~/code");
  });

  it("never touches a clone root already set", async () => {
    const b = seed({
      settings: { ...DEFAULT_SETTINGS, team: { ...DEFAULT_SETTINGS.team, cloneRoot: "~/work" } },
      team: { teamRepo: "acme/team", workspaces: [{ cloned: true, registered: true }] },
    });
    tauri().fixture("plugin:path|resolve_directory", "/Users/ann");
    tauri().fixture("plugin:dialog|open", "/Users/ann/Projects");
    const r = await openSetupPage();
    await r.user.click(within(row("Projects folder")).getByRole("button", { name: "Change…" }));
    await waitFor(() => expect(b.saved().projects.folder).toBe("~/Projects"));
    expect(b.saved().team.cloneRoot).toBe("~/work");
    expect(tauri().callsOf("team_status")).toHaveLength(0);
  });

  it("a cancelled picker writes nothing", async () => {
    const b = seed();
    tauri().fixture("plugin:path|resolve_directory", "/Users/ann");
    tauri().fixture("plugin:dialog|open", null);
    const r = await openSetupPage();
    await r.user.click(within(row("Projects folder")).getByRole("button", { name: "Change…" }));
    await nextFrame();
    // (Opening Settings remembers its page; nothing else is written.)
    expect(b.writes.every((w) => (w.projects.folder ?? null) === null && (w.team.cloneRoot ?? null) === null)).toBe(true);
    expect(tauri().callsOf("team_status")).toHaveLength(0);
  });

  it("lists GitHub accounts, and Manage opens Setup's GitHub step", async () => {
    seed();
    const r = await openSetupPage();
    await waitFor(() => expect(within(row("GitHub accounts")).getByText("2 accounts")).toBeTruthy());
    expect(within(row("GitHub accounts")).getByText("Signed in with 2 accounts: ann (active), ann-work.")).toBeTruthy();
    await r.user.click(within(row("GitHub accounts")).getByRole("button", { name: "Manage" }));
    expect(useSetup.getState()).toMatchObject({ open: true, step: "github" });
  });
});

describe("⌘K", () => {
  it("Open setup opens Setup as a rerun", async () => {
    tauri().allowUnhandled();
    act(() => useWorkspaces.setState({ loaded: true, workspaces: [lyra], activeId: "l" }));
    const r = renderUi(
      <CommandPalette activeWorkspaceId="l" claudeAvailable onOpenInstalledSelfCheck={() => {}} />,
    );
    act(() => useUi.getState().openPalette("commands"));
    await nextFrame();
    const dialog = screen.getByRole("dialog", { name: "Search" });
    await r.user.type(within(dialog).getByRole("textbox", { name: "Search" }), "open setup");
    const list = within(dialog).getByRole("listbox");
    await waitFor(() => expect(within(list).getByText("Open setup")).toBeTruthy());
    await r.user.click(within(list).getByText("Open setup"));
    expect(useSetup.getState()).toMatchObject({ open: true, setupCase: "rerun" });
  });

  it("onboarding and projects folder find Account › Setup", async () => {
    tauri().allowUnhandled();
    act(() => useWorkspaces.setState({ loaded: true, workspaces: [lyra], activeId: "l" }));
    const r = renderUi(
      <CommandPalette activeWorkspaceId="l" claudeAvailable onOpenInstalledSelfCheck={() => {}} />,
    );
    act(() => useUi.getState().openPalette("commands"));
    await nextFrame();
    const dialog = screen.getByRole("dialog", { name: "Search" });
    const field = within(dialog).getByRole("textbox", { name: "Search" });
    await r.user.type(field, "projects folder");
    await waitFor(() => expect(within(dialog).getByText("Projects folder")).toBeTruthy());
    await r.user.click(within(dialog).getByText("Projects folder"));
    expect(useUi.getState().settingsSection).toBe("setup");
  });
});

// Getting started TU-8 (TUTORIAL_SPEC §3.5): the Getting started group —
// the tour (Start, or Resume and Start over), the 1-minute tour and the tips
// switch, Help's field. Settings closes before any of them shows.
describe("Settings › Account › Setup › Getting started", () => {
  it("Start the tour closes Settings and opens the panel; tips follow the level, and the switch writes the field", async () => {
    const { writes } = seed({
      settings: { ...DEFAULT_SETTINGS, onboarding: { ...DEFAULT_SETTINGS.onboarding, level: "guided" } },
    });
    tauri().fixture("plugin:app|version", "1.167.0");
    const r = await openSetupPage();
    const tour = row("Getting started tour");
    expect(within(tour).queryByRole("button", { name: "More for Getting started tour" })).toBeNull();
    const tips = within(row("Tips when I open a section")).getByRole("switch");
    expect(tips.getAttribute("aria-checked")).toBe("true");
    await r.user.click(tips);
    await waitFor(() => expect(writes[writes.length - 1]?.onboarding.tutorial?.tips).toBe(false));
    await r.user.click(within(tour).getByRole("button", { name: "Start the tour" }));
    expect(useUi.getState().settingsOverlayOpen).toBe(false);
    await waitFor(() => expect(writes[writes.length - 1]?.onboarding.tutorial?.startedAt).toBeTruthy());
  });

  it("a tour under way: Resume the tour and Start over; Take a 1-minute tour starts the Quick tour", async () => {
    seed({
      settings: {
        ...DEFAULT_SETTINGS,
        onboarding: {
          ...DEFAULT_SETTINGS.onboarding,
          tutorial: { startedAt: "2026-10-21T09:00:00.000Z", path: "full", done: { "base.how-it-works": "x" } },
        },
      },
    });
    const r = await openSetupPage();
    expect(within(row("Getting started tour")).getByRole("button", { name: "Resume the tour" })).toBeTruthy();
    // G1 walk (tidy tables): Start over is behind ⋯.
    await r.user.click(within(row("Getting started tour")).getByRole("button", { name: "More for Getting started tour" }));
    expect(screen.getByRole("menuitem", { name: "Start over" })).toBeTruthy();
    await r.user.keyboard("{Escape}");
    await r.user.click(within(row("Take a 1-minute tour")).getByRole("button", { name: "Start" }));
    expect(useUi.getState().settingsOverlayOpen).toBe(false);
    // After Settings has given the keyboard back (two frames).
    await waitFor(() => expect(useQuickTour.getState().quick?.index).toBe(0));
    act(() => endQuickTour());
  });
});
