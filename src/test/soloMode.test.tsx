// OB-9 (onboarding §10): solo mode hides the team surfaces — presentation
// only — and Settings › Account › Setup's `Work with a team` turns them back
// on without a relaunch. Every surface of §10's list (rows 1–8) is rendered in
// both modes on the real components and the real stores; the mode comes from
// the backend's `team_work_mode`, answered here the way Rust answers it from
// what was saved.
import { describe, expect, it } from "vitest";
import { within } from "@testing-library/react";
import { SettingsOverlay } from "../components/SettingsOverlay";
import { KanbanBoard } from "../components/KanbanBoard";
import { SkillsPage } from "../components/library/SkillsPage";
import { useSkillsData } from "../components/library/useSkillsData";
import { InboxPanel } from "../components/InboxPanel";
import { CommandPalette } from "../components/CommandPalette";
import { OverlapWarnings } from "../components/OverlapWarnings";
import type { InboxEvent, InboxFeed, LicenseInfo, ProjectSkillsView } from "../ipc";
import { DEFAULT_SETTINGS, useSettings, type Settings } from "../store/settingsStore";
import { useLicense } from "../store/licenseStore";
import { useUi } from "../store/uiStore";
import { useWorkMode } from "../store/workModeStore";
import { useWorkspaces, type Workspace } from "../store/workspaceStore";
import { SOLO_HIDDEN_NOTE } from "../lib/settingsNav";
import { BOARD_WS, seedBoard } from "./boardFixtures";
import { act, nextFrame, renderUi, screen, tauri, waitFor } from "./render";
import { setTeamAllowed } from "./planGates";

type Mode = "solo" | "team";

const NO_KEY: LicenseInfo = {
  status: "none",
  team: null,
  seats: null,
  issuedAt: null,
  expiresAt: null,
  teamRepo: null,
};

// A key naming no team repo: no team signal, so the mode is derived solo — and
// D15 keeps its Licence part on screen anyway.
const KEY: LicenseInfo = {
  status: "valid",
  team: "MB Adv",
  seats: 5,
  issuedAt: 0,
  expiresAt: Date.UTC(2027, 2, 1),
  teamRepo: null,
};

const lyra: Workspace = {
  id: "l",
  name: "Lyra",
  cwd: "/Users/someone/code/lyra",
  createdAt: 1,
  lastOpenedAt: 1,
  openFiles: [],
  activeFile: null,
};

/**
 * The backend as far as the mode goes: `settings_set` keeps what was saved,
 * and `team_work_mode` answers from it — a GitHub Issues board is team
 * whatever was chosen (`team::effective_work_mode`).
 */
function backend(start: Mode | null, workspaces: Workspace[] = [lyra], windowsPage: string | null = null) {
  let saved: Settings = {
    ...DEFAULT_SETTINGS,
    team: { ...DEFAULT_SETTINGS.team, workMode: start },
    windows: { ...DEFAULT_SETTINGS.windows, settingsPage: windowsPage },
  };
  return {
    settings_get: () => saved,
    settings_set: ({ settings }: Record<string, unknown>) => {
      saved = settings as Settings;
      return saved;
    },
    team_work_mode: () => ({
      mode: workspaces.some((w) => w.kanbanSyncMode === "githubIssues")
        ? "team"
        : (saved.team?.workMode ?? "solo"),
      chosen: saved.team?.workMode != null,
    }),
    saved: () => saved,
  };
}

async function seed(
  mode: Mode,
  workspaces: Workspace[] = [lyra],
  {
    info = NO_KEY,
    chosen = true,
    settingsPage = null,
  }: { info?: LicenseInfo; chosen?: boolean; settingsPage?: string | null } = {},
) {
  tauri().allowUnhandled();
  const b = backend(chosen ? mode : null, workspaces, settingsPage);
  tauri().fixture("settings_get", b.settings_get);
  tauri().fixture("settings_set", b.settings_set);
  tauri().fixture("team_work_mode", b.team_work_mode);
  // Board and worktrees reads the checkouts on disk.
  tauri().fixture("worktree_list", []);
  tauri().fixture("worktree_kept_list", []);
  useSettings.setState({ settings: b.settings_get(), loaded: true } as never);
  useLicense.setState({ info, loaded: true } as never);
  setTeamAllowed(true);
  act(() => useWorkspaces.setState({ workspaces, activeId: workspaces[0]?.id ?? null }));
  await act(async () => useWorkMode.getState().refresh());
  expect(useWorkMode.getState().mode).toBe(mode);
  return b;
}

async function openSettings(section?: string) {
  const r = renderUi(<SettingsOverlay />);
  act(() => useUi.getState().setSettingsOverlayOpen(true));
  if (section) act(() => useUi.getState().openSettingsSection(section));
  await screen.findByRole("navigation", { name: "Settings sections" });
  return r;
}

const nav = () => screen.getByRole("navigation", { name: "Settings sections" });
const navGroups = () => within(nav()).getAllByRole("heading", { level: 3 }).map((h) => h.textContent);

describe("§10 row 1 and 2: Settings navigation, Plan and Profile", () => {
  it("solo: no Team group; Setup and account is Setup · Diagnostics · Plan · Profile; no Licence part", async () => {
    await seed("solo");
    await openSettings("profile");
    expect(navGroups()).toEqual(["Look and feel", "Cards", "Project", "Setup and account"]);
    expect(within(nav()).queryByRole("button", { name: "Members and library" })).toBeNull();
    for (const name of ["Setup", "Diagnostics", "Plan", "Profile"]) {
      expect(within(nav()).getByRole("button", { name })).toBeTruthy();
    }
    expect(await screen.findByRole("heading", { level: 1, name: "Profile" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Licence" })).toBeNull();
    expect(screen.queryByText("Team key")).toBeNull();
    expect(screen.queryByText("Take the key off this Mac")).toBeNull();
  });

  it("a stored PLY1 key draws no Licence part any more (launch A3), in solo or team", async () => {
    for (const mode of ["solo", "team"] as const) {
      await seed(mode, [lyra], { info: KEY, chosen: mode === "team" });
      const r = await openSettings("profile");
      expect(await screen.findByRole("heading", { level: 1, name: "Profile" })).toBeTruthy();
      expect(screen.queryByRole("heading", { name: "Licence" })).toBeNull();
      expect(screen.queryByText("Team key")).toBeNull();
      r.unmount();
    }
  });

  it("team: the Team group is drawn beside Plan", async () => {
    await seed("team", [lyra]);
    await openSettings("plan");
    expect(navGroups()).toEqual(["Look and feel", "Cards", "Project", "Team", "Setup and account"]);
    expect(within(nav()).getByRole("button", { name: "Members and library" })).toBeTruthy();
    expect(await screen.findByRole("heading", { level: 1, name: "Plan" })).toBeTruthy();
  });
});

describe("Account › Setup: Work with a team", () => {
  it("drops \"Create or join\" once this computer is in a team, and keeps it until then", async () => {
    await seed("team");
    await openSettings("setup");
    expect(await screen.findByText("Create or join a team in Team › Members and library.")).toBeTruthy();
    act(() =>
      useSettings.setState((s) => ({ settings: { ...s.settings, team: { ...s.settings.team, teamRepo: "mb-adv/team" } } })),
    );
    await waitFor(() => expect(screen.queryByText(/Create or join a team/)).toBeNull());
    expect(screen.getByRole("switch", { name: "Work with a team" }).getAttribute("aria-checked")).toBe("true");
  });

  it("turns team on and off without a relaunch, and writes only settings.team.workMode", async () => {
    const b = await seed("solo");
    const { user } = await openSettings("setup");
    expect(await screen.findByRole("heading", { level: 1, name: "Setup" })).toBeTruthy();
    const toggle = screen.getByRole("switch", { name: "Work with a team" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("Team pages, sharing and GitHub Issues boards are hidden.")).toBeTruthy();

    await user.click(toggle);
    await waitFor(() => expect(navGroups()).toContain("Team"));
    expect(b.saved().team?.workMode).toBe("team");
    expect(screen.getByRole("switch", { name: "Work with a team" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("Create or join a team in Team › Members and library.")).toBeTruthy();

    await user.click(screen.getByRole("switch", { name: "Work with a team" }));
    await waitFor(() => expect(navGroups()).not.toContain("Team"));
    expect(b.saved().team?.workMode).toBe("solo");
    // Nothing else in the settings moved but the answer (and the page
    // Settings remembers, UX-9.4).
    const { team, windows, ...rest } = b.saved();
    const { team: team0, windows: _w, ...rest0 } = { ...DEFAULT_SETTINGS };
    void windows;
    void _w;
    expect(rest).toEqual(rest0);
    expect({ ...team, workMode: null }).toEqual({ ...team0, workMode: null });
  });

  it("refuses solo while a workspace's board is on GitHub Issues, with the way out", async () => {
    const atelier: Workspace = {
      ...lyra,
      id: "a",
      name: "Atelier",
      kanbanSyncMode: "githubIssues",
      githubOwnerRepo: "mb/atelier",
    };
    const b = await seed("team", [atelier]);
    const { user } = await openSettings("setup");
    await screen.findByRole("heading", { level: 1, name: "Setup" });
    const writes = () => tauri().callsOf("settings_set").length;
    const before = writes();
    await user.click(screen.getByRole("switch", { name: "Work with a team" }));
    expect(
      await screen.findByText(
        "“Atelier” uses a GitHub Issues board, which is a team feature. Switch its board to Local first, or keep team on.",
      ),
    ).toBeTruthy();
    expect(writes()).toBe(before);
    expect(b.saved().team?.workMode).toBe("team");
    expect(screen.getByRole("switch", { name: "Work with a team" }).getAttribute("aria-checked")).toBe("true");
    expect(navGroups()).toContain("Team");

    // 1.174.0 (DS1, DS5): the board is General's "Where the cards live".
    await user.click(screen.getByRole("button", { name: "Open board settings" }));
    expect(await screen.findByRole("heading", { level: 1, name: "General" })).toBeTruthy();
    expect(await screen.findByRole("heading", { level: 2, name: "Where the cards live" })).toBeTruthy();
  });
});

describe("§10 row 1: deep links to hidden pages", () => {
  it(`solo: "team-workspaces" lands on Setup with Work with a team marked, and says why`, async () => {
    await seed("solo");
    await openSettings("team-workspaces");
    expect(await screen.findByRole("heading", { level: 1, name: "Setup" })).toBeTruthy();
    expect(screen.getByText(SOLO_HIDDEN_NOTE)).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Found here")).toBeTruthy());
    const found = screen.getByText("Found here").closest(".ux-row");
    expect(found?.textContent).toContain("Work with a team");
  });

  // Launch A3: the plan is the person's, so the old licence links (and the
  // sectioned Settings' `team`) open Plan in solo too, never Setup.
  for (const link of ["plan", "licence", "licence-key", "team"]) {
    it(`solo: "${link}" opens Plan`, async () => {
      await seed("solo");
      await openSettings(link);
      expect(await screen.findByRole("heading", { level: 1, name: "Plan" })).toBeTruthy();
      expect(screen.queryByText(SOLO_HIDDEN_NOTE)).toBeNull();
      expect(screen.queryByRole("heading", { name: "Enter your team key" })).toBeNull();
    });
  }

  it("a remembered Team page reopens on Setup, and turning team on keeps Setup", async () => {
    await seed("solo", [lyra], { settingsPage: "team-workspaces" });
    const { user } = await openSettings();
    expect(await screen.findByRole("heading", { level: 1, name: "Setup" })).toBeTruthy();
    await user.click(screen.getByRole("switch", { name: "Work with a team" }));
    await waitFor(() => expect(navGroups()).toContain("Team"));
    await nextFrame();
    expect(screen.getByRole("heading", { level: 1, name: "Setup" })).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 1, name: "Members and library" })).toBeNull();
  });

  it("team: the Team page opens as it always has", async () => {
    await seed("team");
    await openSettings("team-workspaces");
    expect(await screen.findByRole("heading", { level: 1, name: "Members and library" })).toBeTruthy();
    expect(screen.queryByText(SOLO_HIDDEN_NOTE)).toBeNull();
  });

  it("a page left on Team moves to Setup when the mode turns solo", async () => {
    const b = await seed("team");
    await openSettings("team-workspaces");
    await screen.findByRole("heading", { level: 1, name: "Members and library" });
    await act(async () => {
      await b.settings_set({ settings: { ...b.saved(), team: { ...b.saved().team, workMode: "solo" } } });
      await useWorkMode.getState().refresh();
    });
    expect(await screen.findByRole("heading", { level: 1, name: "Setup" })).toBeTruthy();
  });
});

describe("§10 rows 1, 2, 7: Settings search", () => {
  it("solo: a search for team finds Work with a team, never the Team page or the key", async () => {
    await seed("solo");
    const { user } = await openSettings("appearance");
    await user.type(screen.getByRole("searchbox", { name: /search settings/i }), "team");
    const results = await screen.findByRole("group");
    expect(within(results).getByText("Work with a team")).toBeTruthy();
    expect(within(results).queryByText("Members and library")).toBeNull();
    expect(within(results).queryByText("Join or create a team")).toBeNull();
    expect(within(results).queryByText("Team key")).toBeNull();
  });

  it("team: the Team page is found", async () => {
    await seed("team");
    const { user } = await openSettings("appearance");
    await user.type(screen.getByRole("searchbox", { name: /search settings/i }), "team");
    const results = await screen.findByRole("group");
    expect(within(results).getByText("Members and library")).toBeTruthy();
  });
});

describe("§10 row 4: Board › GitHub Issues backing", () => {
  it("a link to the Board lands on its part on General (1.174.0 DS1)", async () => {
    await seed("solo");
    const scrolled: string[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.id);
    };
    await openSettings("board");
    await screen.findByRole("heading", { level: 1, name: "General" });
    await waitFor(() => expect(scrolled).toContain("settings-part-board"));
    expect(document.getElementById("settings-part-board")?.textContent).toContain("Board");
  });

  it("solo: only Local, and where to turn team on", async () => {
    await seed("solo");
    // Two-account walk: the row says Reading… until the status has landed.
    tauri().fixture("workspace_adoption_status", () => ({
      githubRepo: null,
      hasDefinition: false,
      boardRepo: null,
      action: { kind: "none" },
    }));
    await openSettings("board");
    await screen.findByRole("heading", { level: 1, name: "General" });
    expect(await screen.findByText(/The cards live on this Mac\. Nobody else sees them/)).toBeTruthy();
    expect(screen.getByText(/A board on GitHub Issues is a team feature/)).toBeTruthy();
    expect(screen.queryByText("Back the board with GitHub Issues")).toBeNull();
  });

  // 1.172.0 (B1): the repository's shared setup puts the board on GitHub
  // Issues, and solo keeps it local — said, with the way to a team, instead
  // of "This repository sets its board, so it is the same for everyone".
  it("solo: a repository whose setup says GitHub Issues says why the board stays here", async () => {
    await seed("solo");
    tauri().fixture("workspace_adoption_status", () => ({
      githubRepo: "o/lyra",
      hasDefinition: true,
      boardRepo: "o/lyra",
      repoBoard: "githubIssues",
      action: { kind: "boardHeld", reason: "held" },
    }));
    const { user } = await openSettings("board");
    expect(
      await screen.findByText(
        "This repository's board is on GitHub Issues; while you work alone it stays on this Mac.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/This repository sets its board/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Open Setup" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Setup" })).toBeTruthy();
  });

  it("team: the GitHub Issues row is offered", async () => {
    await seed("team");
    // Two-account walk: the row says Reading… until the status has landed.
    tauri().fixture("workspace_adoption_status", () => ({
      githubRepo: null,
      hasDefinition: false,
      boardRepo: null,
      action: { kind: "none" },
    }));
    await openSettings("board");
    await screen.findByRole("heading", { level: 1, name: "General" });
    expect(await screen.findByText("Back the board with GitHub Issues")).toBeTruthy();
  });
});

describe("§10 row 3: the adoption banner", () => {
  async function board(mode: Mode) {
    await seed(mode);
    seedBoard([]);
    tauri().fixture("workspace_adoption_status", () => ({
      githubRepo: "o/lyra",
      hasDefinition: true,
      boardRepo: "o/lyra",
      action: { kind: "offerBoard", localCards: 2, cardsOnly: false },
    }));
    renderUi(<KanbanBoard workspaceId={BOARD_WS} />);
  }

  // 1.171.0 Block A walk (X2): solo mode reads the status too — a shared
  // setup found on another branch is said there (boardSetupElsewhere.test.tsx)
  // — but offers nothing about sharing or the board, and runs no step.
  it("solo: offers nothing about sharing or the board", async () => {
    await board("solo");
    await nextFrame();
    await act(async () => {});
    expect(screen.queryByRole("region", { name: "Move this board to GitHub Issues?" })).toBeNull();
    expect(tauri().callsOf("workspace_adoption_board_choice")).toHaveLength(0);
    expect(tauri().callsOf("workspace_set_kanban_sync_mode")).toHaveLength(0);
  });

  it("team: asks as it always has", async () => {
    await board("team");
    expect(
      await screen.findByRole("region", { name: "Move this board to GitHub Issues?" }),
    ).toBeTruthy();
  });
});

describe("§10 row 5: the Library's Team scope", () => {
  const WS = "ws-ob9";
  const CWD = "/Users/someone/code/project";
  const view: ProjectSkillsView = {
    workspaceId: WS,
    workspaceName: "project",
    cwd: CWD,
    skills: [],
    team: [
      {
        name: "review",
        description: "Reviews it.",
        plugin: "ply-team",
        claude: true,
        codex: true,
        repo: "absent",
        dir: "/tmp/team/review",
        ignoredRoots: [],
        unknownRoots: [],
        codexName: null,
      },
    ],
    unloadable: [],
    rootsPresent: [],
    ignoredRoots: [],
    configured: true,
    hasClone: true,
    canPromote: true,
    promoteReason: null,
    promotePlugin: "ply-team",
    errors: [],
  };
  function Host() {
    const data = useSkillsData(WS, true);
    return <SkillsPage workspaceId={WS} cwd={CWD} data={data} />;
  }
  async function library(mode: Mode) {
    await seed(mode);
    const r = renderUi(<Host />, {
      fixtures: {
        project_skills_view: () => view,
        knowledge_project_state: () => {
          throw new Error("not shared");
        },
        personal_skills_view: () => ({
          skills: [
            {
              name: "deploy",
              codexName: null,
              description: "Ships it.",
              claude: true,
              codex: false,
              roots: [".claude/skills"],
              dir: "/Users/someone/.claude/skills/deploy",
            },
          ],
          rootsPresent: [".claude/skills"],
          errors: [],
        }),
        skills_hub_links: () => ({ links: [], unreadable: [] }),
        ply_skills_view: () => ({ skills: [], problem: null }),
        personal_skill_promote: () => {
          throw "The disk said no.";
        },
      },
      withToasts: true,
    });
    await screen.findByRole("button", { name: "deploy" });
    return r;
  }

  it("solo: no team section, and Promote offers only this repository", async () => {
    const { user } = await library("solo");
    expect(screen.queryByText("In the team library")).toBeNull();
    expect(screen.queryByRole("button", { name: "review" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Promote" }));
    expect(await screen.findByText(/Where should/)).toBeTruthy();
    expect(screen.getByRole("radio", { name: /This repository/ })).toBeTruthy();
    expect(screen.queryByRole("radio", { name: /^Team/ })).toBeNull();
    // Cold read (Challenger): solo mode keeps its words and its choice.
    expect(screen.getByText("Promote · 1 step")).toBeTruthy();
    expect(screen.getByRole("radio", { name: /This repository/, checked: true })).toBeTruthy();
    // The refusal's title says the flow's own verb.
    await user.click(screen.getByRole("button", { name: "Promote" }));
    expect(await screen.findByText(/^Couldn't promote the skill\.?$/)).toBeTruthy();
  });

  it("team: the team section and the Team choice", async () => {
    const { user } = await library("team");
    expect(screen.getByText("In the team library")).toBeTruthy();
    expect(screen.getByRole("button", { name: "review" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Share with Team…" }));
    expect(await screen.findByRole("radio", { name: /^Team/ })).toBeTruthy();
  });
});

describe("§10 row 6: the Inbox's review-requested pull requests", () => {
  const NOW = Date.now();
  const ev = (over: Partial<InboxEvent> & Pick<InboxEvent, "id" | "kind" | "title">): InboxEvent => ({
    group: "needs_you",
    workspaceId: "l",
    workspaceName: "Lyra",
    cardId: null,
    runId: null,
    detail: null,
    url: null,
    at: NOW - 60_000,
    seenAt: null,
    seenEligible: true,
    ...over,
  });
  const feed: InboxFeed = {
    generatedAt: NOW,
    windowDays: 28,
    events: [
      ev({ id: "pr", kind: "pr_review", title: "PR #7 · Fix the login", url: "https://x/7" }),
      ev({ id: "run", kind: "run_done", title: "A card that ran" }),
    ],
    costRollup: [],
    eligibilityProof: {} as InboxFeed["eligibilityProof"],
  };

  it("solo: not listed", async () => {
    await seed("solo");
    tauri().fixture("inbox_feed", feed);
    renderUi(<InboxPanel />);
    expect(await screen.findByText("A card that ran")).toBeTruthy();
    expect(screen.queryByText("PR #7 · Fix the login")).toBeNull();
  });

  it("team: listed", async () => {
    await seed("team");
    tauri().fixture("inbox_feed", feed);
    renderUi(<InboxPanel />);
    expect(await screen.findByText("PR #7 · Fix the login")).toBeTruthy();
  });
});

describe("§10 row 7: the command palette", () => {
  async function palette(mode: Mode, query: string) {
    await seed(mode);
    const r = renderUi(
      <CommandPalette activeWorkspaceId="l" claudeAvailable onOpenInstalledSelfCheck={() => {}} />,
    );
    act(() => useUi.getState().openPalette("commands"));
    await nextFrame();
    const dialog = screen.getByRole("dialog", { name: "Search" });
    await r.user.type(within(dialog).getByRole("textbox", { name: "Search" }), query);
    return { list: within(dialog).getByRole("listbox"), unmount: r.unmount };
  }

  it("solo: no Team or Join or create a team; licence finds the plan", async () => {
    const { list, unmount } = await palette("solo", "team");
    await waitFor(() => expect(within(list).getByText("Work with a team")).toBeTruthy());
    expect(within(list).queryByText("Members and library")).toBeNull();
    expect(within(list).queryByText("Join or create a team")).toBeNull();
    unmount();
    const { list: licence } = await palette("solo", "licence");
    await waitFor(() => expect(within(licence).getByText("Plan")).toBeTruthy());
    expect(within(licence).queryByText("Licence")).toBeNull();
    expect(within(licence).queryByText("Team key")).toBeNull();
  });

  it("team: Team and Join or create a team are offered", async () => {
    const { list } = await palette("team", "team");
    await waitFor(() => expect(within(list).getByText("Members and library")).toBeTruthy());
    expect(within(list).getByText("Join or create a team")).toBeTruthy();
  });
});

describe("§10 row 8: the overlap warning's teammate half", () => {
  const rows = [
    { kind: "local_card", otherId: "c2", otherTitle: "Another card", files: ["a.ts"] },
    { kind: "teammate_pr", otherId: "9", otherTitle: "PR #9 · Theirs", files: ["a.ts"] },
  ];

  it("solo: not fetched (the local half stays)", async () => {
    await seed("solo");
    tauri().fixture("card_overlap_check", ({ teammates }: Record<string, unknown>) =>
      teammates === false ? rows.slice(0, 1) : rows,
    );
    renderUi(<OverlapWarnings workspaceId="l" cardId="c1" />);
    expect(await screen.findByText("card “Another card”")).toBeTruthy();
    expect(screen.queryByText("PR #9 · Theirs")).toBeNull();
    expect(tauri().callsOf("card_overlap_check").map((c) => c.args.teammates)).toEqual([false]);
  });

  it("team: both halves", async () => {
    await seed("team");
    tauri().fixture("card_overlap_check", rows);
    renderUi(<OverlapWarnings workspaceId="l" cardId="c1" />);
    expect(await screen.findByText("PR #9 · Theirs")).toBeTruthy();
    // SP-2: the amber callout, its words, no "⚠" glyph.
    expect(screen.getByText("Overlapping edits")).toBeTruthy();
    expect(screen.getByRole("note").textContent).not.toContain("⚠");
    expect(tauri().callsOf("card_overlap_check")[0].args.teammates).toBe(true);
  });
});
