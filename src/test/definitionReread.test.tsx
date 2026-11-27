// Two-account walk, 2026-11-02 (step 6): the owner moved a shared project's board
// to GitHub Issues, and for 9 min 24 s the member's General still said "This
// repository's board is Local" and offered "Move to GitHub Issues": the
// definition was read only when a workspace warmed and every ten minutes, and
// Team's "Read it again" only read the team. It reads the project now, and so
// does Settings › Project opening — once, and only reading: nothing is published.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, within } from "@testing-library/react";
import { useAdoptionStatus } from "../components/AdoptionBanner";
import { BoardPage } from "../components/settings/BoardPage";
import { SettingsOverlay } from "../components/SettingsOverlay";
import { TeamPage } from "../components/settings/TeamPage";
import type { LicenseInfo, TeamStatus } from "../ipc";
import type { AdoptionStatus } from "../lib/adoption";
import {
  PROJECT_READ_FAILED_WORDS,
  definitionReadKey,
  pageReadFoundNothing,
  type RefreshMoment,
} from "../lib/definitionRefresh";
import { setPlatformForTests } from "../lib/platform";
import type { Settings } from "../lib/settingsShape";
import {
  DEFINITION_PAGE_IDLE_MS,
  DEFINITION_PAGE_READ_EVERY_MS,
  DEFINITION_READ_HOLD_MS,
  DEFINITION_REREAD_MIN_MS,
  askForStatusAgain,
  definitionReadDueIn,
  noteDefinitionRead,
  readDefinition,
  readDefinitionIfDue,
  useDefinitionReads,
} from "../store/definitionReadStore";
import { observeLibraryRefusal, useErrorBlocks } from "../store/errorBlockStore";
import { useLicense } from "../store/licenseStore";
import { useSettingsFlow } from "../store/settingsFlowStore";
import { DEFAULT_SETTINGS, useSettings } from "../store/settingsStore";
import { useToasts } from "../store/toastStore";
import { useUi } from "../store/uiStore";
import { useWorkMode } from "../store/workModeStore";
import { useWorkspaces } from "../store/workspaceStore";
import { setTeamAllowed } from "./planGates";
import { act, renderUi, screen, tauri, waitFor } from "./render";

const WS = "ws-shared";
const REFRESHED = "workspace-definition://refreshed";
const LICENSE = { status: "valid", team: "Team", teamRepo: "boss/team" } as unknown as LicenseInfo;
const OFFLINE = "fatal: unable to access: could not resolve host: github.com";

function workspace(board: "local" | "githubIssues") {
  return {
    id: WS,
    name: "lyra",
    cwd: "/r/lyra",
    kanbanSyncMode: board,
    githubOwnerRepo: board === "local" ? null : "boss/lyra",
  };
}

function seed(board: "local" | "githubIssues" = "local") {
  useLicense.setState({ info: LICENSE, loaded: true } as never);
  setTeamAllowed(true);
  useWorkspaces.setState({ workspaces: [workspace(board)], activeId: WS } as never);
}

function report(over: Record<string, unknown> = {}) {
  return { workspaceId: WS, moment: "pageRead", changes: [], hasDefinition: true, fetchError: null, ...over };
}

const BOARD_CHANGE = { changes: [{ field: "board", label: "Board", value: "githubIssues" }] };

function adoption(repoBoard: "local" | "githubIssues"): AdoptionStatus {
  return {
    action: { kind: "none" },
    repoBoard,
    hasDefinition: true,
    githubRepo: "boss/lyra",
    boardRepo: "boss/lyra",
  } as unknown as AdoptionStatus;
}

function withPage(page: string): Settings {
  return { ...DEFAULT_SETTINGS, windows: { settings: null, settingsPage: page } };
}

const pageFixtures = {
  workspace_definition_get: null,
  project_config_get: { targetBranch: "main" },
  project_review_get: { selfCheck: true, reviewChecklist: [] },
  worktree_settings_get: {},
};

function openSettings(page: string, fixtures: Record<string, unknown>, fakeTimers = false) {
  tauri().allowUnhandled();
  const settings = withPage(page);
  useSettings.setState({ settings, loaded: true } as never);
  const r = renderUi(<SettingsOverlay />, {
    fakeTimers,
    fixtures: {
      settings_get: () => settings,
      settings_set: ({ settings: s }: Record<string, unknown>) => s,
      ...pageFixtures,
      ...fixtures,
    } as never,
  });
  act(() => useUi.getState().setSettingsOverlayOpen(true));
  return r;
}

function closeSettings() {
  act(() => useUi.getState().setSettingsOverlayOpen(false));
}

/** An answer the test gives by hand. */
function held<T = unknown>(answer: () => T = () => report() as T) {
  let finish = () => {};
  const promise = new Promise<T>((resolve) => {
    finish = () => resolve(answer());
  });
  return { answer: promise, finish: () => finish() };
}

async function settle(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  // jsdom's document never has the focus; this window does, unless a test says.
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  useSettingsFlow.getState().close();
  useWorkMode.setState({ mode: "team" } as never);
});

describe("reading a project's definition", () => {
  it("a page opening reads once, only reading, and not again within the minimum interval", async () => {
    vi.useFakeTimers();
    tauri().fixture("workspace_definition_refresh", () => report());
    const calls = () => tauri().callsOf("workspace_definition_refresh");

    readDefinitionIfDue(WS);
    await settle();
    expect(calls()).toHaveLength(1);
    expect(calls()[0].args).toMatchObject({ workspaceId: WS, moment: "pageRead" });

    await settle(DEFINITION_REREAD_MIN_MS - 1);
    readDefinitionIfDue(WS);
    await settle();
    expect(calls()).toHaveLength(1);

    await settle(1);
    readDefinitionIfDue(WS);
    await settle();
    expect(calls()).toHaveLength(2);
  });

  it("a report from a Sync or a publish counts as a read; one that didn't reach the remote doesn't", async () => {
    noteDefinitionRead({ workspaceId: "reached", fetchError: null });
    expect(definitionReadDueIn("reached")).toBeGreaterThan(0);
    noteDefinitionRead({ workspaceId: "unreached", fetchError: OFFLINE });
    expect(definitionReadDueIn("unreached")).toBe(0);
  });

  it("a second asker joins the read that is running; a press later isn't held by the interval", async () => {
    const read = held();
    tauri().fixture("workspace_definition_refresh", () => read.answer);
    const first = readDefinition(WS);
    const second = readDefinition(WS);
    readDefinitionIfDue(WS);
    await act(async () => {});
    expect(tauri().callsOf("workspace_definition_refresh")).toHaveLength(1);
    expect(useDefinitionReads.getState().reading[WS]).toBe(true);
    read.finish();
    await act(async () => {
      await Promise.all([first, second]);
    });
    expect(useDefinitionReads.getState().reading[WS]).toBeUndefined();
    await act(async () => {
      await readDefinition(WS);
    });
    expect(tauri().callsOf("workspace_definition_refresh")).toHaveLength(2);
  });

  it("a ten-minute read that finds a page's read running follows it, since it also publishes", async () => {
    const read = held();
    tauri().fixture("workspace_definition_refresh", () => read.answer);
    const page = readDefinition(WS);
    const periodic = readDefinition(WS, "periodic");
    read.finish();
    await act(async () => {
      await Promise.all([page, periodic]);
    });
    expect(tauri().callsOf("workspace_definition_refresh").map((c) => c.args.moment)).toEqual([
      "pageRead",
      "periodic",
    ]);
  });

  it("offline, the read returns with fetchError: no toast, and the next opening may read again", async () => {
    tauri().fixture("workspace_definition_refresh", () => report({ fetchError: OFFLINE }));
    let outcome: unknown;
    await act(async () => {
      outcome = await readDefinition(WS);
    });
    expect(outcome).toBe("unreached");
    expect(useToasts.getState().toasts).toHaveLength(0);
    expect(useDefinitionReads.getState().reading[WS]).toBeUndefined();
    expect(definitionReadDueIn(WS)).toBe(0);
    readDefinitionIfDue(WS);
    await act(async () => {});
    expect(tauri().callsOf("workspace_definition_refresh")).toHaveLength(2);
  });

  it("a read that didn't run (the folder is gone) only logs", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    tauri().fixture("workspace_definition_refresh", () => {
      throw new Error("/r/lyra is missing");
    });
    let outcome: unknown;
    await act(async () => {
      outcome = await readDefinition(WS);
    });
    expect(outcome).toBe("failed");
    expect(warn).toHaveBeenCalled();
    expect(useToasts.getState().toasts).toHaveLength(0);
    warn.mockRestore();
  });

  it("a read for a page says nothing about a refused library push", () => {
    const refused = { branch: "main", refused: "no", pending: ["note"] };
    observeLibraryRefusal(WS, "periodic", refused);
    const block = () => useErrorBlocks.getState().byWorkspace[WS]?.publishRefused ?? null;
    expect(block()).not.toBeNull();
    observeLibraryRefusal(WS, "pageRead", null);
    expect(block()).not.toBeNull();
    observeLibraryRefusal(WS, "periodic", null);
    expect(block()).toBeNull();
  });
});

describe("Settings › Team › Read it again", () => {
  const member = {
    teamRepo: "boss/team",
    teamName: "Team",
    ownerLogin: "boss",
    members: [{ login: "boss", owner: true }],
    isOwner: false,
    ignoredRepos: [],
    login: "friend",
    membership: "member",
    membershipStale: false,
    cloneRoot: "/c",
    cloneRootIsDefault: true,
    hasClone: true,
    workspaces: [],
    skills: [],
    refusedSkills: [],
    canWriteLibrary: false,
    error: null,
  } as unknown as TeamStatus;

  function team(fixtures: Record<string, unknown> = {}, fakeTimers = false) {
    const r = renderUi(<TeamPage scope="team" />, {
      fakeTimers,
      fixtures: {
        team_status: () => member,
        team_refresh: () => member,
        team_work_mode: { mode: "team", chosen: true },
        team_member_states: { members: [], problems: [] },
        ...fixtures,
      } as never,
    });
    r.tauri.allowUnhandled();
    return r;
  }

  it("reads the open project's definition too, and says so only once that has landed", async () => {
    seed();
    const read = held();
    const r = team({ workspace_definition_refresh: () => read.answer });
    // Opening Team reads the team, not the project.
    expect(await screen.findByText("Read just now")).toBeTruthy();
    expect(r.tauri.callsOf("workspace_definition_refresh")).toHaveLength(0);

    await r.user.click(screen.getByRole("button", { name: "Read it again" }));
    await waitFor(() => expect(r.tauri.callsOf("workspace_definition_refresh")).toHaveLength(1));
    expect(r.tauri.callsOf("workspace_definition_refresh")[0].args).toMatchObject({
      workspaceId: WS,
      moment: "pageRead",
    });
    await waitFor(() => expect(r.tauri.callsOf("team_refresh").length).toBeGreaterThanOrEqual(2));
    expect(screen.getByRole("button", { name: "Reading…" })).toBeTruthy();
    expect(screen.queryByText("Read just now")).toBeNull();

    read.finish();
    expect(await screen.findByText("Read just now")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Read it again" })).toBeTruthy();
    // A press: every status on screen reads again.
    expect(useDefinitionReads.getState().statusAsked[WS]).toBe(1);
  });

  it("a project read that didn't reach the remote claims nothing, and says so", async () => {
    seed();
    const r = team({ workspace_definition_refresh: () => report({ fetchError: OFFLINE }) });
    await screen.findByText("Read just now");
    await r.user.click(screen.getByRole("button", { name: "Read it again" }));
    expect(await screen.findByText(PROJECT_READ_FAILED_WORDS)).toBeTruthy();
    expect(screen.queryByText("Read just now")).toBeNull();
    expect(useToasts.getState().toasts).toHaveLength(0);
    // Back online: the next press claims it again.
    r.tauri.fixture("workspace_definition_refresh", () => report());
    await r.user.click(screen.getByRole("button", { name: "Read it again" }));
    expect(await screen.findByText("Read just now")).toBeTruthy();
    expect(screen.queryByText(PROJECT_READ_FAILED_WORDS)).toBeNull();
  });

  it("a project read that didn't run claims nothing, says so, and blames no network", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    seed();
    const r = team({
      workspace_definition_refresh: () => {
        throw new Error("/r/lyra is missing");
      },
    });
    await screen.findByText("Read just now");
    await r.user.click(screen.getByRole("button", { name: "Read it again" }));
    await waitFor(() => expect(r.tauri.callsOf("workspace_definition_refresh")).toHaveLength(1));
    await screen.findByRole("button", { name: "Read it again" });
    expect(screen.queryByText("Read just now")).toBeNull();
    expect(screen.getByText(PROJECT_READ_FAILED_WORDS)).toBeTruthy();
    expect(PROJECT_READ_FAILED_WORDS).not.toMatch(/online|network|GitHub/i);
    warn.mockRestore();
  });

  it("a read on a network that hangs gives the button back after the hold, with no claim", async () => {
    seed();
    const read = held();
    const r = team({ workspace_definition_refresh: () => read.answer }, true);
    await settle();
    await settle();
    await r.user.click(screen.getByRole("button", { name: "Read it again" }));
    await settle();
    expect(screen.getByRole("button", { name: "Reading…" })).toBeTruthy();
    await settle(DEFINITION_READ_HOLD_MS - 1);
    expect(screen.getByRole("button", { name: "Reading…" })).toBeTruthy();
    await settle(1);
    expect(screen.getByRole("button", { name: "Read it again" })).toBeTruthy();
    expect(screen.queryByText("Read just now")).toBeNull();
    read.finish();
    await settle();
    expect(screen.getByText("Read just now")).toBeTruthy();
  });

  it("with no project open it reads the team alone", async () => {
    useLicense.setState({ info: LICENSE, loaded: true } as never);
    setTeamAllowed(true);
    useWorkspaces.setState({ workspaces: [], activeId: null } as never);
    const r = team();
    await r.user.click(await screen.findByRole("button", { name: "Read it again" }));
    await screen.findByText("Read just now");
    expect(r.tauri.callsOf("workspace_definition_refresh")).toHaveLength(0);
  });
});

describe("Settings › Project opening", () => {
  it("reads the definition once, stays quiet while open, and doesn't read again on a quick return", async () => {
    seed();
    const r = openSettings("general", {
      workspace_adoption_status: () => adoption("local"),
      workspace_definition_refresh: () => report(),
    });
    await waitFor(() => expect(r.tauri.callsOf("workspace_definition_refresh")).toHaveLength(1));
    // Another page of the same group.
    const nav = await screen.findByRole("navigation", { name: "Settings sections" });
    await r.user.click(within(nav).getByRole("button", { name: "Areas" }));
    await screen.findByRole("heading", { level: 1, name: "Areas" });
    closeSettings();
    act(() => useUi.getState().setSettingsOverlayOpen(true));
    await screen.findByRole("dialog", { name: "Settings" });
    await act(async () => {});
    expect(r.tauri.callsOf("workspace_definition_refresh")).toHaveLength(1);
  });

  it("a page outside the group reads nothing", async () => {
    seed();
    const r = openSettings("appearance", {
      workspace_adoption_status: () => adoption("local"),
      workspace_definition_refresh: () => report(),
    });
    await screen.findByRole("heading", { level: 1, name: "Appearance" });
    await act(async () => {});
    expect(r.tauri.callsOf("workspace_definition_refresh")).toHaveLength(0);
  });

  it("just read: it reads when the interval ends, then every minute while the page is open", async () => {
    vi.useFakeTimers();
    seed();
    noteDefinitionRead({ workspaceId: WS });
    await vi.advanceTimersByTimeAsync(10_000);
    const r = openSettings(
      "general",
      {
        workspace_adoption_status: () => adoption("local"),
        workspace_definition_refresh: () => report(),
      },
      true,
    );
    const calls = () => r.tauri.callsOf("workspace_definition_refresh");
    await settle();
    expect(calls()).toHaveLength(0);
    await settle(DEFINITION_REREAD_MIN_MS - 10_001);
    expect(calls()).toHaveLength(0);
    await settle(1);
    expect(calls()).toHaveLength(1);
    await settle(DEFINITION_PAGE_READ_EVERY_MS - 1);
    expect(calls()).toHaveLength(1);
    await settle(1);
    expect(calls()).toHaveLength(2);
    expect(calls().every((c) => c.args.moment === "pageRead")).toBe(true);
  });

  it("closed before the interval ends, the waiting read doesn't run", async () => {
    vi.useFakeTimers();
    seed();
    noteDefinitionRead({ workspaceId: WS });
    const r = openSettings(
      "general",
      {
        workspace_adoption_status: () => adoption("local"),
        workspace_definition_refresh: () => report(),
      },
      true,
    );
    await settle();
    closeSettings();
    await settle(DEFINITION_REREAD_MIN_MS * 2);
    expect(r.tauri.callsOf("workspace_definition_refresh")).toHaveLength(0);
  });

  it("the move waits for the read, and the row follows what the read found", async () => {
    seed();
    const read = held();
    let repoBoard: "local" | "githubIssues" = "local";
    const r = openSettings("general", {
      workspace_adoption_status: () => adoption(repoBoard),
      workspace_definition_refresh: () => read.answer,
    });
    // The last answer stays on screen, but it can't be acted on yet.
    await screen.findByText(/This repository's board is Local/);
    expect(screen.queryByRole("button", { name: "Move to GitHub Issues" })).toBeNull();
    const button = screen.getByRole("button", { name: "Reading…" });
    expect(button.getAttribute("aria-disabled")).toBe("true");

    // The owner had moved it: the read changed the board, as the ten-minute one does.
    repoBoard = "githubIssues";
    act(() => {
      seed("githubIssues");
      r.tauri.emit(REFRESHED, report(BOARD_CHANGE));
    });
    read.finish();
    expect(await screen.findByText(/On GitHub Issues · boss\/lyra/)).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Reading…" })).toBeNull());
    expect(screen.queryByRole("button", { name: "Move to GitHub Issues" })).toBeNull();
    expect(screen.queryByText(/This repository's board is Local/)).toBeNull();
  });

  it("offline, the read returning with fetchError: the row comes back with the last answer, and no error", async () => {
    seed();
    const r = openSettings("general", {
      workspace_adoption_status: () => adoption("local"),
      workspace_definition_refresh: () => report({ fetchError: OFFLINE }),
    });
    expect(await screen.findByRole("button", { name: "Move to GitHub Issues" })).toBeTruthy();
    expect(r.tauri.callsOf("workspace_definition_refresh")).toHaveLength(1);
    expect(useToasts.getState().toasts).toHaveLength(0);
  });

  it("a read that hangs holds the move for the hold and no longer", async () => {
    vi.useFakeTimers();
    seed();
    const read = held();
    openSettings(
      "general",
      {
        workspace_adoption_status: () => adoption("local"),
        workspace_definition_refresh: () => read.answer,
      },
      true,
    );
    await settle();
    await settle();
    expect(screen.getByRole("button", { name: "Reading…" })).toBeTruthy();
    await settle(DEFINITION_READ_HOLD_MS);
    expect(screen.getByRole("button", { name: "Move to GitHub Issues" })).toBeTruthy();
    read.finish();
    await settle();
  });

  it("a slow status (gh) holds the first answer for the hold and no longer, then lands", async () => {
    vi.useFakeTimers();
    seed();
    const status = held(() => adoption("local"));
    openSettings(
      "general",
      {
        workspace_adoption_status: () => status.answer,
        workspace_definition_refresh: () => report(),
      },
      true,
    );
    await settle();
    await settle();
    expect(screen.queryByRole("button", { name: "Choose a repository" })).toBeNull();
    await settle(DEFINITION_READ_HOLD_MS);
    expect(screen.getByRole("button", { name: "Choose a repository" })).toBeTruthy();
    status.finish();
    await settle();
    expect(screen.getByRole("button", { name: "Move to GitHub Issues" })).toBeTruthy();
  });

  it("a status reload after a shared edit holds nothing, and the mark stays", async () => {
    seed();
    const r = openSettings("general", {
      workspace_adoption_status: () => adoption("githubIssues"),
      workspace_definition_refresh: () => report(),
    });
    await screen.findByText(/^This repository's board is on GitHub Issues; /);
    await waitFor(() => expect(r.tauri.callsOf("workspace_definition_refresh")).toHaveLength(1));
    const section = () => screen.getByRole("heading", { level: 2, name: "Where the cards live" }).closest("section") as HTMLElement;
    expect(within(section()).getByText("shared with the project")).toBeTruthy();

    r.tauri.fixture("workspace_adoption_status", () => new Promise(() => {}));
    act(() => r.tauri.emit("workspace-definition://edited", WS));
    act(() => r.tauri.emit(REFRESHED, report({ moment: "publish", ...BOARD_CHANGE })));
    act(() => r.tauri.emit(REFRESHED, report({ moment: "periodic" })));
    await act(async () => {});
    expect(screen.queryByRole("button", { name: "Reading…" })).toBeNull();
    expect(within(section()).getByText("shared with the project")).toBeTruthy();
  });

  it("a read that changed something holds the move until the status it brings lands", async () => {
    seed();
    const r = openSettings("general", {
      workspace_adoption_status: () => adoption("local"),
      workspace_definition_refresh: () => report(),
    });
    await screen.findByRole("button", { name: "Move to GitHub Issues" });
    const status = held(() => adoption("local"));
    r.tauri.fixture("workspace_adoption_status", () => status.answer);
    act(() => r.tauri.emit(REFRESHED, report(BOARD_CHANGE)));
    expect(await screen.findByRole("button", { name: "Reading…" })).toBeTruthy();
    status.finish();
    expect(await screen.findByRole("button", { name: "Move to GitHub Issues" })).toBeTruthy();
  });

  it("a Name being typed stays when the read lands", async () => {
    seed();
    const read = held();
    const r = openSettings("general", {
      workspace_adoption_status: () => adoption("local"),
      workspace_definition_refresh: () => read.answer,
    });
    const name = (await screen.findByRole("textbox", { name: "Name" })) as HTMLInputElement;
    await r.user.clear(name);
    await r.user.type(name, "Lyra web");
    act(() => r.tauri.emit(REFRESHED, report()));
    read.finish();
    await act(async () => {});
    await waitFor(() => expect(screen.queryByRole("button", { name: "Reading…" })).toBeNull());
    expect((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("Lyra web");
  });

  describe("when the project starts or stops sharing under someone typing", () => {
    const definition = (name: string) => ({
      cache: {
        schemaVersion: 1,
        definition: { schemaVersion: 1, name, board: "local" },
        source: "repo",
        branch: "main",
        pending: {},
        writeAccess: { readOnly: false },
      },
      effective: { schemaVersion: 1, name, board: "local" },
      defaultBranch: "main",
      queue: { fields: {} },
    });
    const bar = () => screen.queryByRole("button", { name: /^Publish/ });

    it("gaining a shared definition keeps the typed Name, which then asks to be published", async () => {
      seed();
      let view: unknown = null;
      const r = openSettings("general", {
        workspace_adoption_status: () => adoption("local"),
        workspace_definition_refresh: () => report(),
        workspace_definition_get: () => view,
      });
      const name = (await screen.findByRole("textbox", { name: "Name" })) as HTMLInputElement;
      expect(bar()).toBeNull();
      await r.user.clear(name);
      await r.user.type(name, "Lyra web");

      // The shared definition arrives, with another Name.
      view = definition("Team Lyra");
      act(() => r.tauri.emit(REFRESHED, report()));
      await screen.findAllByText(/shared with the project/);
      expect((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("Lyra web");

      await r.user.tab();
      await waitFor(() => expect(bar()).not.toBeNull());
      expect((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("Lyra web");
      // Nothing published by itself.
      expect(r.tauri.callsOf("workspace_definition_save")).toHaveLength(0);
    });

    it("losing it keeps the drafted Name, saved on this Mac", async () => {
      seed();
      let view: unknown = definition("Team Lyra");
      const r = openSettings("general", {
        workspace_adoption_status: () => adoption("local"),
        workspace_definition_refresh: () => report(),
        workspace_definition_get: () => view,
        workspace_rename: null,
      });
      await screen.findAllByText(/shared with the project/);
      const name = (await screen.findByRole("textbox", { name: "Name" })) as HTMLInputElement;
      await r.user.clear(name);
      await r.user.type(name, "Lyra web");
      await waitFor(() => expect(bar()).not.toBeNull());

      view = null;
      act(() => r.tauri.emit(REFRESHED, report({ hasDefinition: false })));
      await waitFor(() => expect(bar()).toBeNull());
      expect((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("Lyra web");
      await waitFor(() => expect(r.tauri.callsOf("workspace_rename")).toHaveLength(1));
      expect(r.tauri.callsOf("workspace_rename")[0].args).toMatchObject({ name: "Lyra web" });
    });
  });
});

describe("a Project page stays current while it is open", () => {
  /** The owner's side: until `move()`, the board is Local; from then on, the next
   *  read finds it moved, as the backend reports it. */
  function owner() {
    let moved = false;
    let told = false;
    return {
      move: () => {
        moved = true;
      },
      fixtures: {
        workspace_adoption_status: () => adoption(moved ? "githubIssues" : "local"),
        workspace_definition_refresh: () => {
          const answer = report(moved ? { commit: "c2" } : { commit: "c1" });
          if (moved && !told) {
            told = true;
            seed("githubIssues");
            tauri().emit(REFRESHED, { ...answer, ...BOARD_CHANGE });
            return { ...answer, ...BOARD_CHANGE };
          }
          tauri().emit(REFRESHED, answer);
          return answer;
        },
      },
    };
  }
  const reads = () => tauri().callsOf("workspace_definition_refresh");
  const statuses = () => tauri().callsOf("workspace_adoption_status");

  async function openOnGeneral(fixtures: Record<string, unknown>) {
    vi.useFakeTimers();
    seed();
    const r = openSettings("general", fixtures, true);
    await settle();
    await settle();
    return r;
  }

  it("a page left open picks up a board the owner moved, and stops offering the move", async () => {
    const side = owner();
    await openOnGeneral(side.fixtures);
    expect(screen.getByRole("button", { name: "Move to GitHub Issues" })).toBeTruthy();
    side.move();
    await settle(DEFINITION_PAGE_READ_EVERY_MS);
    await settle();
    expect(screen.getByText(/On GitHub Issues · boss\/lyra/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Move to GitHub Issues" })).toBeNull();
    expect(screen.queryByText(/This repository's board is Local/)).toBeNull();
  });

  it("Areas → General picks it up: at once when a read is due", async () => {
    const side = owner();
    const r = await openOnGeneral(side.fixtures);
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    await r.user.click(within(nav).getByRole("button", { name: "Areas" }));
    await settle();
    // The retry at the guard's end, then the guard over again with no read due.
    await settle(DEFINITION_REREAD_MIN_MS);
    await settle(DEFINITION_REREAD_MIN_MS);
    const before = reads().length;
    side.move();
    await r.user.click(within(nav).getByRole("button", { name: "General" }));
    await settle();
    await settle();
    expect(reads().length).toBe(before + 1);
    expect(screen.getByText(/On GitHub Issues · boss\/lyra/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Move to GitHub Issues" })).toBeNull();
  });

  it("Areas → General inside the guard: not at once, and when the interval ends", async () => {
    const side = owner();
    const r = await openOnGeneral(side.fixtures);
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    await r.user.click(within(nav).getByRole("button", { name: "Areas" }));
    await settle();
    const before = reads().length;
    side.move();
    await r.user.click(within(nav).getByRole("button", { name: "General" }));
    await settle();
    expect(reads().length).toBe(before);
    await settle(DEFINITION_REREAD_MIN_MS);
    await settle();
    expect(reads().length).toBe(before + 1);
    expect(screen.getByText(/On GitHub Issues · boss\/lyra/)).toBeTruthy();
  });

  it("behind another app it waits; coming back reads once, then every minute", async () => {
    const side = owner();
    await openOnGeneral(side.fixtures);
    const before = reads().length;
    act(() => window.dispatchEvent(new Event("blur")));
    await settle(DEFINITION_PAGE_READ_EVERY_MS * 5);
    expect(reads().length).toBe(before);
    act(() => window.dispatchEvent(new Event("focus")));
    await settle();
    expect(reads().length).toBe(before + 1);
    await settle(DEFINITION_PAGE_READ_EVERY_MS);
    expect(reads().length).toBe(before + 2);
  });

  it("a hidden window waits too", async () => {
    const side = owner();
    await openOnGeneral(side.fixtures);
    const before = reads().length;
    const hidden = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await settle(DEFINITION_PAGE_READ_EVERY_MS * 3);
    expect(reads().length).toBe(before);
    hidden.mockRestore();
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await settle();
    expect(reads().length).toBe(before + 1);
  });

  it("a read that hangs isn't overlapped", async () => {
    const hanging = held();
    await openOnGeneral({
      workspace_adoption_status: () => adoption("local"),
      workspace_definition_refresh: () => hanging.answer,
    });
    await settle(DEFINITION_PAGE_READ_EVERY_MS * 3);
    expect(reads()).toHaveLength(1);
    hanging.finish();
    await settle();
    await settle(DEFINITION_PAGE_READ_EVERY_MS);
    expect(reads()).toHaveLength(2);
  });

  it("no timer stays behind when the page closes, leaves the group or the workspace changes", async () => {
    const side = owner();
    const r = await openOnGeneral(side.fixtures);
    const before = reads().length;
    // Another group.
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    await r.user.click(within(nav).getByRole("button", { name: "Appearance" }));
    await settle();
    await settle(DEFINITION_PAGE_READ_EVERY_MS * 3);
    expect(reads().length).toBe(before);
    // Back, then another workspace: only that one is read from then on.
    await r.user.click(within(nav).getByRole("button", { name: "General" }));
    await settle();
    expect(reads().length).toBe(before + 1);
    act(() =>
      useWorkspaces.setState({
        workspaces: [workspace("local"), { ...workspace("local"), id: "other" }],
        activeId: "other",
      } as never),
    );
    await settle();
    await settle(DEFINITION_PAGE_READ_EVERY_MS);
    const last = reads().slice(before + 1);
    expect(last.length).toBeGreaterThan(0);
    expect(last.every((c) => c.args.workspaceId === "other")).toBe(true);
    // Closed: nothing more.
    const count = reads().length;
    closeSettings();
    await settle(DEFINITION_PAGE_READ_EVERY_MS * 3);
    expect(reads().length).toBe(count);
    expect(vi.getTimerCount()).toBeLessThan(5);
  });

  it("a read after the first holds no button and no mark, and costs no status when nothing changed", async () => {
    const hanging = held();
    let calls = 0;
    await openOnGeneral({
      workspace_adoption_status: () => adoption("local"),
      workspace_definition_refresh: () => {
        calls += 1;
        if (calls === 3) return hanging.answer;
        const answer = report({ commit: "c1" });
        tauri().emit(REFRESHED, answer);
        return answer;
      },
    });
    await settle(DEFINITION_PAGE_READ_EVERY_MS);
    await settle();
    const before = statuses().length;
    // The third read is running, and the button doesn't move.
    await settle(DEFINITION_PAGE_READ_EVERY_MS);
    expect(calls).toBe(3);
    expect(screen.getByRole("button", { name: "Move to GitHub Issues" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reading…" })).toBeNull();
    hanging.finish();
    await settle();
    await settle(DEFINITION_PAGE_READ_EVERY_MS * 2);
    expect(calls).toBeGreaterThan(3);
    expect(statuses().length).toBe(before);
  });

  it("a read that found another commit does read the status, though no field changed here", async () => {
    let commit = "c1";
    await openOnGeneral({
      workspace_adoption_status: () => adoption("local"),
      workspace_definition_refresh: () => {
        const answer = report({ commit });
        tauri().emit(REFRESHED, answer);
        return answer;
      },
    });
    await settle(DEFINITION_PAGE_READ_EVERY_MS);
    await settle();
    const before = statuses().length;
    commit = "c2";
    await settle(DEFINITION_PAGE_READ_EVERY_MS);
    await settle();
    expect(statuses().length).toBeGreaterThan(before);
  });

  it("the ten-minute read still reads the status, and holds no button while it runs", async () => {
    const r = await openOnGeneral({
      workspace_adoption_status: () => adoption("local"),
      workspace_definition_refresh: () => report(),
    });
    await settle();
    const before = statuses().length;
    act(() => r.tauri.emit(REFRESHED, report({ moment: "periodic" })));
    await settle();
    expect(statuses().length).toBeGreaterThan(before);
    const hanging = held();
    r.tauri.fixture("workspace_definition_refresh", () => hanging.answer);
    await settle(DEFINITION_REREAD_MIN_MS);
    const running = readDefinition(WS, "periodic", { quiet: true });
    await settle();
    expect(screen.queryByRole("button", { name: "Reading…" })).toBeNull();
    hanging.finish();
    await settle();
    await running;
  });

  it("a Name being typed stays through a read every minute, and the page isn't redrawn under it", async () => {
    const side = owner();
    const r = await openOnGeneral(side.fixtures);
    const name = screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement;
    name.focus();
    await r.user.clear(name);
    await r.user.type(name, "Lyra web");
    await settle(DEFINITION_PAGE_READ_EVERY_MS);
    await settle();
    const after = screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement;
    expect(after).toBe(name);
    expect(after.value).toBe("Lyra web");
    expect(document.activeElement).toBe(name);
  });
});

describe("what a Project page reads, and when it holds", () => {
  const reads = () => tauri().callsOf("workspace_definition_refresh");
  const statuses = () => tauri().callsOf("workspace_adoption_status");
  const every = DEFINITION_PAGE_READ_EVERY_MS;

  async function open(fixtures: Record<string, unknown>) {
    vi.useFakeTimers();
    seed();
    const r = openSettings("general", fixtures, true);
    await settle();
    await settle();
    return r;
  }
  const quietly = { workspace_adoption_status: () => adoption("local"), workspace_definition_refresh: () => report() };

  it("no shared definition: the read on arriving and no repeat", async () => {
    await open({
      workspace_adoption_status: () => ({ ...adoption("local"), hasDefinition: false, repoBoard: null }),
      workspace_definition_refresh: () => report({ hasDefinition: false }),
    });
    expect(reads()).toHaveLength(1);
    await settle(every * 5);
    expect(reads()).toHaveLength(1);
  });

  it("a solo computer: the read on arriving and no repeat", async () => {
    useWorkMode.setState({ mode: "solo" } as never);
    await open(quietly);
    expect(reads()).toHaveLength(1);
    await settle(every * 5);
    expect(reads()).toHaveLength(1);
  });

  it("the status landing with a definition starts the repeat, a minute on", async () => {
    const status = held(() => adoption("local"));
    await open({ workspace_adoption_status: () => status.answer, workspace_definition_refresh: () => report() });
    expect(reads()).toHaveLength(1);
    status.finish();
    await settle();
    await settle(every - 1);
    expect(reads()).toHaveLength(1);
    await settle(1);
    expect(reads()).toHaveLength(2);
  });

  it("a window without the focus doesn't read until it gets it", async () => {
    vi.mocked(document.hasFocus).mockReturnValue(false);
    await open(quietly);
    await settle(every * 2);
    expect(reads()).toHaveLength(0);
    act(() => window.dispatchEvent(new Event("focus")));
    await settle();
    expect(reads()).toHaveLength(1);
  });

  it("a press in the window counts, whatever hasFocus last said", async () => {
    vi.mocked(document.hasFocus).mockReturnValue(false);
    await open(quietly);
    act(() => window.dispatchEvent(new Event("pointerdown")));
    await settle();
    expect(reads()).toHaveLength(1);
  });

  it("visible again but without the focus: still waiting", async () => {
    await open(quietly);
    const before = reads().length;
    const hidden = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    hidden.mockRestore();
    vi.mocked(document.hasFocus).mockReturnValue(false);
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await settle(every * 2);
    expect(reads().length).toBe(before);
  });

  it("15 minutes with no input stops the repeat; input reads once and it goes on", async () => {
    await open(quietly);
    await settle(DEFINITION_PAGE_IDLE_MS + every);
    const stopped = reads().length;
    expect(stopped).toBeLessThanOrEqual(Math.ceil(DEFINITION_PAGE_IDLE_MS / every) + 1);
    await settle(every * 10);
    expect(reads().length).toBe(stopped);
    act(() => window.dispatchEvent(new Event("pointermove")));
    await settle();
    expect(reads().length).toBe(stopped + 1);
    act(() => window.dispatchEvent(new Event("keydown")));
    await settle();
    expect(reads().length).toBe(stopped + 1);
    await settle(every);
    expect(reads().length).toBe(stopped + 2);
  });

  it("input keeps it reading past 15 minutes", async () => {
    await open(quietly);
    for (let i = 0; i < 20; i += 1) {
      act(() => window.dispatchEvent(new Event("pointermove")));
      await settle(every);
    }
    expect(reads().length).toBe(21);
  });

  it("a return to the app doesn't hold the presses", async () => {
    await open(quietly);
    const hanging = held();
    tauri().fixture("workspace_definition_refresh", () => hanging.answer);
    act(() => window.dispatchEvent(new Event("blur")));
    await settle(every * 2);
    act(() => window.dispatchEvent(new Event("focus")));
    await settle();
    expect(screen.getByRole("button", { name: "Move to GitHub Issues" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reading…" })).toBeNull();
    hanging.finish();
    await settle();
  });

  it("entering a page with a recent answer on screen doesn't hold them; an old answer does", async () => {
    const r = await open(quietly);
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    await r.user.click(within(nav).getByRole("button", { name: "Appearance" }));
    await settle();
    await settle(DEFINITION_REREAD_MIN_MS);
    const hanging = held();
    tauri().fixture("workspace_definition_refresh", () => hanging.answer);
    await r.user.click(within(nav).getByRole("button", { name: "General" }));
    await settle();
    expect(reads().length).toBe(2);
    expect(screen.queryByRole("button", { name: "Reading…" })).toBeNull();
    hanging.finish();
    await settle();

    await r.user.click(within(nav).getByRole("button", { name: "Appearance" }));
    await settle(every * 3);
    const again = held();
    tauri().fixture("workspace_definition_refresh", () => again.answer);
    await r.user.click(within(nav).getByRole("button", { name: "General" }));
    await settle();
    expect(screen.getByRole("button", { name: "Reading…" })).toBeTruthy();
    again.finish();
    await settle();
  });

  it("offline, coming and going doesn't hold the presses each time", async () => {
    const r = await open({
      workspace_adoption_status: () => adoption("local"),
      workspace_definition_refresh: () => report({ fetchError: OFFLINE }),
    });
    const hanging = held();
    tauri().fixture("workspace_definition_refresh", () => hanging.answer);
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    await r.user.click(within(nav).getByRole("button", { name: "Areas" }));
    await settle();
    await r.user.click(within(nav).getByRole("button", { name: "General" }));
    await settle();
    act(() => window.dispatchEvent(new Event("blur")));
    act(() => window.dispatchEvent(new Event("focus")));
    await settle();
    expect(screen.queryByRole("button", { name: "Reading…" })).toBeNull();
    hanging.finish();
    await settle();
  });

  it("a read-only member's unchanged read costs no definition read and no status", async () => {
    const view = {
      cache: { schemaVersion: 1, definition: { schemaVersion: 1, name: "lyra", board: "local" }, branch: "main", pending: {} },
      effective: { schemaVersion: 1, name: "lyra", board: "local" },
      defaultBranch: "main",
      queue: { fields: {} },
      readOnly: true,
    };
    await open({
      workspace_adoption_status: () => adoption("local"),
      workspace_definition_get: () => view,
      workspace_definition_refresh: () => {
        const answer = report({ commit: "c1", readOnly: true });
        tauri().emit(REFRESHED, answer);
        return answer;
      },
    });
    await settle(every);
    await settle();
    const gets = () => tauri().callsOf("workspace_definition_get").length;
    const seen = gets();
    const statusesSeen = statuses().length;
    await settle(every * 3);
    await settle();
    expect(reads().length).toBeGreaterThanOrEqual(5);
    expect(gets()).toBe(seen);
    expect(statuses().length).toBe(statusesSeen);
    // Another commit: both read.
    tauri().fixture("workspace_definition_refresh", () => {
      const answer = report({ commit: "c2", readOnly: true });
      tauri().emit(REFRESHED, answer);
      return answer;
    });
    await settle(every);
    await settle();
    expect(gets()).toBeGreaterThan(seen);
    expect(statuses().length).toBeGreaterThan(statusesSeen);
  });

  it("a reload that fails after a key was seen: the next unchanged read reloads the page", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await open({
      workspace_adoption_status: () => adoption("local"),
      workspace_definition_get: () => null,
      workspace_definition_refresh: () => report({ commit: "c1" }),
    });
    const gets = () => r.tauri.callsOf("workspace_definition_get").length;
    act(() => r.tauri.emit(REFRESHED, report({ commit: "c1" })));
    await settle();
    const seen = gets();
    act(() => r.tauri.emit(REFRESHED, report({ commit: "c1" })));
    await settle();
    expect(gets()).toBe(seen);
    // An edit's reload fails.
    r.tauri.fixture("workspace_definition_get", () => {
      throw new Error("no");
    });
    act(() => r.tauri.emit("workspace-definition://edited", WS));
    await settle();
    const failed = gets();
    expect(failed).toBeGreaterThan(seen);
    r.tauri.fixture("workspace_definition_get", () => null);
    act(() => r.tauri.emit(REFRESHED, report({ commit: "c1" })));
    await settle();
    expect(gets()).toBe(failed + 1);
    warn.mockRestore();
  });

  it("a failed definition reload isn't seen: the next unchanged read tries again", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await open({
      workspace_adoption_status: () => adoption("local"),
      workspace_definition_get: () => {
        throw new Error("no");
      },
      workspace_definition_refresh: () => report({ commit: "c1" }),
    });
    const gets = () => r.tauri.callsOf("workspace_definition_get").length;
    act(() => r.tauri.emit(REFRESHED, report({ commit: "c1" })));
    await settle();
    const before = gets();
    act(() => r.tauri.emit(REFRESHED, report({ commit: "c1" })));
    await settle();
    expect(gets()).toBe(before + 1);
    warn.mockRestore();
  });
});

describe("a read joined after another keeps its quiet", () => {
  it("a quiet ten-minute read following a page's read holds nothing once it starts", async () => {
    const page = held();
    const periodic = held();
    let call = 0;
    tauri().fixture("workspace_definition_refresh", () => {
      call += 1;
      return call === 1 ? page.answer : periodic.answer;
    });
    const first = readDefinition(WS);
    const second = readDefinition(WS, "periodic", { quiet: true });
    await act(async () => {});
    expect(useDefinitionReads.getState().reading[WS]).toBe(true);
    page.finish();
    await act(async () => {
      await first;
    });
    await waitFor(() => expect(call).toBe(2));
    expect(useDefinitionReads.getState().reading[WS]).toBeUndefined();
    periodic.finish();
    await act(async () => {
      await second;
    });
  });
});

describe("a press reads the status whatever the definition did", () => {
  it("asking again reloads a status the skip would have left", async () => {
    tauri().allowUnhandled();
    tauri().fixture("workspace_adoption_status", () => adoption("local"));
    const { result } = renderHook(() => useAdoptionStatus(WS));
    await waitFor(() => expect(result.current.settled).toBe(true));
    act(() => tauri().emit(REFRESHED, report({ commit: "c1" })));
    await waitFor(() => expect(tauri().callsOf("workspace_adoption_status")).toHaveLength(2));
    act(() => tauri().emit(REFRESHED, report({ commit: "c1" })));
    await act(async () => {});
    expect(tauri().callsOf("workspace_adoption_status")).toHaveLength(2);
    tauri().fixture("workspace_adoption_status", () => adoption("githubIssues"));
    act(() => askForStatusAgain(WS));
    await waitFor(() => expect(result.current.status?.repoBoard).toBe("githubIssues"));
  });

  it("a key already seen, then a failed status: the next unchanged read tries again", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    tauri().allowUnhandled();
    tauri().fixture("workspace_adoption_status", () => adoption("local"));
    const { result } = renderHook(() => useAdoptionStatus(WS));
    await waitFor(() => expect(result.current.settled).toBe(true));
    act(() => tauri().emit(REFRESHED, report({ commit: "c1" })));
    await waitFor(() => expect(tauri().callsOf("workspace_adoption_status")).toHaveLength(2));
    await act(async () => {});
    // Seen: the same read costs nothing.
    act(() => tauri().emit(REFRESHED, report({ commit: "c1" })));
    await act(async () => {});
    expect(tauri().callsOf("workspace_adoption_status")).toHaveLength(2);
    // Then a status fails.
    tauri().fixture("workspace_adoption_status", () => {
      throw new Error("gh said no");
    });
    act(() => askForStatusAgain(WS));
    await waitFor(() => expect(tauri().callsOf("workspace_adoption_status")).toHaveLength(3));
    await act(async () => {});
    tauri().fixture("workspace_adoption_status", () => adoption("githubIssues"));
    act(() => tauri().emit(REFRESHED, report({ commit: "c1" })));
    await waitFor(() => expect(result.current.status?.repoBoard).toBe("githubIssues"));
    warn.mockRestore();
  });

  it("only a page's read that found nothing is skipped: a publish or periodic report never", async () => {
    const seen = { hasDefinition: true, source: null, branch: null, commit: "c1", unreadable: null };
    const key = definitionReadKey(seen);
    const found = (moment: RefreshMoment, changes: unknown[] = []) =>
      pageReadFoundNothing({ ...seen, moment, changes }, key);
    expect(found("pageRead")).toBe(true);
    for (const moment of ["periodic", "publish", "open", "sync", "startBuild"] as const) {
      expect(found(moment)).toBe(false);
    }
    expect(found("pageRead", [{ field: "board" }])).toBe(false);
    expect(pageReadFoundNothing({ ...seen, moment: "pageRead", commit: "c2" }, key)).toBe(false);
    expect(pageReadFoundNothing({ ...seen, moment: "pageRead" }, null)).toBe(false);

    // And on the hook: the same commit, from another moment, reads the status.
    tauri().allowUnhandled();
    tauri().fixture("workspace_adoption_status", () => adoption("local"));
    const { result } = renderHook(() => useAdoptionStatus(WS));
    await waitFor(() => expect(result.current.settled).toBe(true));
    act(() => tauri().emit(REFRESHED, report({ commit: "c1" })));
    await waitFor(() => expect(tauri().callsOf("workspace_adoption_status")).toHaveLength(2));
    await act(async () => {});
    for (const [moment, calls] of [["periodic", 3], ["publish", 4]] as const) {
      act(() => tauri().emit(REFRESHED, report({ commit: "c1", moment })));
      await waitFor(() => expect(tauri().callsOf("workspace_adoption_status")).toHaveLength(calls));
      await act(async () => {});
    }
  });

  it("a failed status isn't seen: the next unchanged read tries again", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    tauri().allowUnhandled();
    tauri().fixture("workspace_adoption_status", () => adoption("local"));
    const { result } = renderHook(() => useAdoptionStatus(WS));
    await waitFor(() => expect(result.current.settled).toBe(true));
    tauri().fixture("workspace_adoption_status", () => {
      throw new Error("gh said no");
    });
    act(() => tauri().emit(REFRESHED, report({ commit: "c1" })));
    await waitFor(() => expect(tauri().callsOf("workspace_adoption_status")).toHaveLength(2));
    await act(async () => {});
    tauri().fixture("workspace_adoption_status", () => adoption("githubIssues"));
    act(() => tauri().emit(REFRESHED, report({ commit: "c1" })));
    await waitFor(() => expect(result.current.status?.repoBoard).toBe("githubIssues"));
    warn.mockRestore();
  });
});

describe("the other moves read first too", () => {
  const list = {
    workspace_list: () => ({ workspaces: useWorkspaces.getState().workspaces, activeId: WS }),
    workspace_cwd_exists: true,
  };

  async function ask(fixtures: Record<string, unknown>) {
    seed();
    tauri().allowUnhandled();
    const r = renderUi(
      <BoardPage scope="repository" workspaceId={WS} adoption={{ action: { kind: "none" } } as never} />,
      { fixtures: { ...list, ...fixtures } as never },
    );
    await r.user.click(screen.getByRole("button", { name: "Choose a repository" }));
    await r.user.type(await screen.findByRole("textbox", { name: "Repository" }), "boss/lyra");
    return r;
  }

  it("Use it, and the owner has moved the board: nothing is set, and the question goes", async () => {
    const r = await ask({
      workspace_definition_refresh: () => report(),
      workspace_adoption_status: () => adoption("githubIssues"),
      workspace_set_kanban_sync_mode: () => 0,
    });
    await r.user.click(screen.getByRole("button", { name: "Use it" }));
    await waitFor(() => expect(useSettingsFlow.getState().flow).toBeNull());
    expect(r.tauri.callsOf("workspace_definition_refresh")[0].args.moment).toBe("pageRead");
    expect(r.tauri.callsOf("workspace_set_kanban_sync_mode")).toHaveLength(0);
    expect(useDefinitionReads.getState().statusAsked[WS]).toBe(1);
  });

  it("Use it, and nothing moved: it goes ahead", async () => {
    const r = await ask({
      workspace_definition_refresh: () => report(),
      workspace_adoption_status: () => ({ action: { kind: "none" }, hasDefinition: false, githubRepo: null, boardRepo: null }),
      workspace_set_kanban_sync_mode: () => 0,
      kanban_list: () => [],
    });
    await r.user.click(screen.getByRole("button", { name: "Use it" }));
    await waitFor(() => expect(r.tauri.callsOf("workspace_set_kanban_sync_mode")).toHaveLength(1));
  });

  it("Use it, after an automatic switch that failed (switchBoard): it is the manual retry", async () => {
    const r = await ask({
      workspace_definition_refresh: () => report(),
      workspace_adoption_status: () => ({
        ...adoption("githubIssues"),
        action: { kind: "switchBoard", localCards: 0 },
      }),
      workspace_set_kanban_sync_mode: () => 0,
      kanban_list: () => [],
    });
    await r.user.click(screen.getByRole("button", { name: "Use it" }));
    await waitFor(() => expect(r.tauri.callsOf("workspace_set_kanban_sync_mode")).toHaveLength(1));
    expect(r.tauri.callsOf("workspace_set_kanban_sync_mode")[0].args).toMatchObject({
      mode: "githubIssues",
      repo: "boss/lyra",
    });
  });

  it("Use it, cancelled while it reads: nothing is set", async () => {
    const read = held();
    const r = await ask({
      workspace_definition_refresh: () => read.answer,
      workspace_adoption_status: () => ({ action: { kind: "none" }, hasDefinition: false, githubRepo: null, boardRepo: null }),
      workspace_set_kanban_sync_mode: () => 0,
    });
    await r.user.click(screen.getByRole("button", { name: "Use it" }));
    await r.user.click(await screen.findByRole("button", { name: "Cancel" }));
    read.finish();
    await act(async () => {});
    await waitFor(() => expect(r.tauri.callsOf("workspace_adoption_status").length).toBeGreaterThan(0));
    await act(async () => {});
    expect(r.tauri.callsOf("workspace_set_kanban_sync_mode")).toHaveLength(0);
  });

  function moveBack(fixtures: Record<string, unknown>) {
    seed("githubIssues");
    tauri().allowUnhandled();
    return renderUi(
      <BoardPage scope="repository" workspaceId={WS} adoption={{ action: { kind: "none" } } as never} />,
      { fixtures: { ...list, ...fixtures } as never },
    );
  }

  it("Move back, and the repository sets the board now: nothing is set", async () => {
    const r = moveBack({
      workspace_definition_refresh: () => report(),
      workspace_adoption_status: () => adoption("githubIssues"),
      workspace_set_kanban_sync_mode: () => 0,
    });
    await r.user.click(screen.getByRole("button", { name: "Move the board back to this Mac" }));
    await waitFor(() => expect(useDefinitionReads.getState().statusAsked[WS]).toBe(1));
    expect(r.tauri.callsOf("workspace_set_kanban_sync_mode")).toHaveLength(0);
  });

  it("Move back, and nothing moved: it goes ahead", async () => {
    const r = moveBack({
      workspace_definition_refresh: () => report(),
      workspace_adoption_status: () => ({ action: { kind: "none" }, hasDefinition: false, githubRepo: "boss/lyra", boardRepo: "boss/lyra" }),
      workspace_set_kanban_sync_mode: () => 0,
    });
    await r.user.click(screen.getByRole("button", { name: "Move the board back to this Mac" }));
    await waitFor(() => expect(r.tauri.callsOf("workspace_set_kanban_sync_mode")).toHaveLength(1));
    expect(r.tauri.callsOf("workspace_set_kanban_sync_mode")[0].args).toMatchObject({ mode: "local" });
  });

  it("moveKept finding the board moved tells the page", async () => {
    seed();
    tauri().allowUnhandled();
    const r = renderUi(
      <BoardPage scope="repository" workspaceId={WS} setByRepository adoption={adoption("local")} />,
      {
        fixtures: {
          ...list,
          workspace_definition_refresh: () => report(),
          workspace_adoption_status: () => adoption("githubIssues"),
        } as never,
      },
    );
    await r.user.click(screen.getByRole("button", { name: "Move to GitHub Issues" }));
    await waitFor(() => expect(useDefinitionReads.getState().statusAsked[WS]).toBe(1));
    expect(r.tauri.callsOf("workspace_set_kanban_sync_mode")).toHaveLength(0);
  });
});

describe("the press that moves a board", () => {
  function move(fixtures: Record<string, unknown>) {
    seed();
    tauri().allowUnhandled();
    return renderUi(
      <BoardPage scope="repository" workspaceId={WS} setByRepository adoption={adoption("local")} />,
      {
        fixtures: {
          workspace_list: () => ({ workspaces: useWorkspaces.getState().workspaces, activeId: WS }),
          workspace_cwd_exists: true,
          ...fixtures,
        } as never,
      },
    );
  }
  const sheet = "Move this repository's board to GitHub Issues?";

  it("reads first; moved already, it asks nothing and moves nothing", async () => {
    const read = held();
    const r = move({
      workspace_definition_refresh: () => read.answer,
      workspace_adoption_status: () => adoption("githubIssues"),
    });
    await r.user.click(screen.getByRole("button", { name: "Move to GitHub Issues" }));
    await waitFor(() => expect(r.tauri.callsOf("workspace_definition_refresh")).toHaveLength(1));
    expect(r.tauri.callsOf("workspace_definition_refresh")[0].args.moment).toBe("pageRead");
    expect(screen.queryByRole("dialog", { name: sheet })).toBeNull();
    expect(screen.getByRole("button", { name: "Reading…" })).toBeTruthy();
    read.finish();
    await waitFor(() => expect(r.tauri.callsOf("workspace_adoption_status").length).toBeGreaterThan(0));
    await act(async () => {});
    await waitFor(() => expect(screen.queryByRole("button", { name: "Reading…" })).toBeNull());
    expect(screen.queryByRole("dialog", { name: sheet })).toBeNull();
    expect(r.tauri.callsOf("workspace_set_kanban_sync_mode")).toHaveLength(0);
  });

  it("still Local: it asks, as before", async () => {
    const r = move({
      workspace_definition_refresh: () => report(),
      workspace_adoption_status: () => adoption("local"),
    });
    await r.user.click(screen.getByRole("button", { name: "Move to GitHub Issues" }));
    expect(await screen.findByRole("dialog", { name: sheet })).toBeTruthy();
  });

  it("offline, the read returning with fetchError: it acts on what this Mac knows", async () => {
    const r = move({
      workspace_definition_refresh: () => report({ fetchError: OFFLINE }),
      workspace_adoption_status: () => adoption("local"),
    });
    await r.user.click(screen.getByRole("button", { name: "Move to GitHub Issues" }));
    expect(await screen.findByRole("dialog", { name: sheet })).toBeTruthy();
  });

  it("a read that hangs doesn't hold the press beyond the hold", async () => {
    const read = held();
    const r = move({
      workspace_definition_refresh: () => read.answer,
      workspace_adoption_status: () => adoption("local"),
    });
    vi.useFakeTimers();
    act(() => screen.getByRole("button", { name: "Move to GitHub Issues" }).click());
    await settle();
    expect(screen.queryByRole("dialog", { name: sheet })).toBeNull();
    await settle(DEFINITION_READ_HOLD_MS);
    expect(screen.getByRole("dialog", { name: sheet })).toBeTruthy();
    expect(r.tauri.callsOf("workspace_set_kanban_sync_mode")).toHaveLength(0);
    read.finish();
    await settle();
  });
});

describe("a link to a Board row while it is being read", () => {
  it("waits for the row, and doesn't say it isn't there", async () => {
    seed();
    let land: (s: AdoptionStatus) => void = () => {};
    const status = new Promise<AdoptionStatus>((resolve) => {
      land = resolve;
    });
    const row = "Back the board with GitHub Issues";
    openSettings("general", {
      workspace_adoption_status: () => status,
      workspace_definition_refresh: () => report(),
    });
    act(() => useUi.getState().openSettingsSection("general", { row }));
    // General's own rows have landed; the Board part is still reading.
    await screen.findByRole("textbox", { name: "Name" });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    expect(document.body.textContent).not.toContain("is not on this page");
    expect(screen.queryByText(row)).toBeNull();
    act(() => land({ action: { kind: "none" }, hasDefinition: false, githubRepo: null, boardRepo: null }));
    expect(await screen.findByText(row)).toBeTruthy();
    expect(document.body.textContent).not.toContain("is not on this page");
  });
});

describe("the repository question, when a late read finds the board has moved", () => {
  it("goes away, so the page and the navigation come back", async () => {
    seed();
    tauri().allowUnhandled();
    const r = renderUi(<BoardPage scope="repository" workspaceId={WS} adoption={{ action: { kind: "none" } } as never} />);
    await r.user.click(screen.getByRole("button", { name: "Choose a repository" }));
    expect(await screen.findByText("Which repository holds the cards?")).toBeTruthy();
    act(() => {
      seed("githubIssues");
    });
    r.rerender(
      <BoardPage scope="repository" workspaceId={WS} setByRepository adoption={adoption("githubIssues")} />,
    );
    await waitFor(() => expect(useSettingsFlow.getState().flow).toBeNull());
    expect(screen.queryByText("Which repository holds the cards?")).toBeNull();
    expect(screen.getByText(/On GitHub Issues · boss\/lyra/)).toBeTruthy();
  });

  it("stays while nothing has moved", async () => {
    seed();
    tauri().allowUnhandled();
    const r = renderUi(<BoardPage scope="repository" workspaceId={WS} adoption={{ action: { kind: "none" } } as never} />);
    await r.user.click(screen.getByRole("button", { name: "Choose a repository" }));
    expect(await screen.findByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(useSettingsFlow.getState().flow).toBe("board-repo");
  });
});

describe("the Board row while where the cards live is unknown", () => {
  function section() {
    return screen.getByRole("heading", { level: 2, name: "Where the cards live" }).closest("section") as HTMLElement;
  }

  it("before the first answer: Reading…, not on this Mac and Choose a repository", () => {
    seed();
    tauri().allowUnhandled();
    renderUi(<BoardPage scope="repository" workspaceId={WS} reading />);
    expect(within(section()).getByText("Reading…")).toBeTruthy();
    expect(within(section()).queryByText("on this Mac")).toBeNull();
    expect(screen.queryByText("The cards live on this Mac. Nobody else sees them.")).toBeNull();
    expect(screen.queryByText("Back the board with GitHub Issues")).toBeNull();
    expect(screen.queryByRole("button", { name: "Choose a repository" })).toBeNull();
  });

  it("no longer reading, with no answer (the read failed): the page as before", () => {
    seed();
    tauri().allowUnhandled();
    renderUi(<BoardPage scope="repository" workspaceId={WS} />);
    expect(screen.getByRole("button", { name: "Choose a repository" })).toBeTruthy();
  });

  it("a local board reread: the last answer stays, the press waits, the focus stays", async () => {
    seed();
    tauri().allowUnhandled();
    const answer = { action: { kind: "none" } } as never;
    const r = renderUi(<BoardPage scope="repository" workspaceId={WS} adoption={answer} />);
    const button = screen.getByRole("button", { name: "Choose a repository" }) as HTMLButtonElement;
    button.focus();
    r.rerender(<BoardPage scope="repository" workspaceId={WS} reading adoption={answer} />);
    expect(screen.getByText("The cards live on this Mac. Nobody else sees them.")).toBeTruthy();
    const same = screen.getByRole("button", { name: "Reading…" }) as HTMLButtonElement;
    expect(same).toBe(button);
    expect(same.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(same);
    await r.user.keyboard("{Enter}");
    expect(useSettingsFlow.getState().flow).toBeNull();
    r.rerender(<BoardPage scope="repository" workspaceId={WS} adoption={answer} />);
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute("aria-disabled")).toBeNull();
  });

  it("a GitHub Issues board reread: Move back waits too", async () => {
    seed("githubIssues");
    tauri().allowUnhandled();
    const r = renderUi(
      <BoardPage scope="repository" workspaceId={WS} reading adoption={{ action: { kind: "none" } } as never} />,
    );
    expect(screen.queryByRole("button", { name: "Move the board back to this Mac" })).toBeNull();
    await r.user.click(screen.getByRole("button", { name: "Reading…" }));
    expect(r.tauri.callsOf("workspace_set_kanban_sync_mode")).toHaveLength(0);
  });

  it("on Windows the words are the same, for this PC", () => {
    setPlatformForTests("windows");
    seed();
    tauri().allowUnhandled();
    renderUi(<BoardPage scope="repository" workspaceId={WS} reading adoption={{ action: { kind: "none" } } as never} />);
    expect(screen.getByText("The cards live on this PC. Nobody else sees them.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reading…" })).toBeTruthy();
  });
});

describe("useAdoptionStatus", () => {
  it("what it holds is per workspace: another workspace's change holds nothing here", async () => {
    tauri().allowUnhandled();
    seed();
    const pendingForA = held(() => adoption("local"));
    tauri().fixture("workspace_adoption_status", ({ workspaceId }: Record<string, unknown>) =>
      workspaceId === "a" ? pendingForA.answer : adoption("local"),
    );
    const { result, rerender } = renderHook(({ id }: { id: string }) => useAdoptionStatus(id), {
      initialProps: { id: "b" },
    });
    await waitFor(() => expect(result.current.settled).toBe(true));
    rerender({ id: "a" });
    act(() => tauri().emit(REFRESHED, report({ workspaceId: "a", ...BOARD_CHANGE })));
    await waitFor(() => expect(result.current.changing).toBe(true));
    rerender({ id: "b" });
    expect(result.current.changing).toBe(false);
    rerender({ id: "a" });
    expect(result.current.changing).toBe(true);
    pendingForA.finish();
    await waitFor(() => expect(result.current.changing).toBe(false));
  });
});
