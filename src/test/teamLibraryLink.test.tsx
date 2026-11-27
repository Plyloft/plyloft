// UX-9.5: Settings › Members and library no longer lists the team's skills —
// the Library does, with their reach, a comparison and `Remove from Team…`.
// The Team page draws one row that counts them and opens the Library on its
// Team scope, closing Settings on the way. A plugin a CLI refused is still a
// row of its own here: the Library has no row for a skill that never loaded.
import { describe, expect, it } from "vitest";
import { TeamPage } from "../components/settings/TeamPage";
import type { LicenseInfo, TeamSkill, TeamStatus } from "../ipc";
import { useLicense } from "../store/licenseStore";
import { useLibrary } from "../store/libraryStore";
import { useUi } from "../store/uiStore";
import { useWorkspaces, type Workspace } from "../store/workspaceStore";
import { act, renderUi, screen, waitFor } from "./render";
import { setTeamAllowed } from "./planGates";

const LICENSE = {
  status: "valid",
  team: "MB Adv",
  teamRepo: "mb/team",
} as unknown as LicenseInfo;

const skill = (name: string, codex: boolean): TeamSkill => ({
  name,
  codexName: null,
  description: `What ${name} does.`,
  plugin: "team",
  claude: true,
  codex,
});

function teamStatus(): TeamStatus {
  return {
    teamRepo: "mb/team",
    teamName: "MB Adv",
    ownerLogin: "owner",
    members: [],
    isOwner: false,
    ignoredRepos: [],
    login: "me",
    membership: "member",
    membershipReason: null,
    membershipStale: false,
    cloneRoot: "/Users/me/code",
    cloneRootIsDefault: true,
    hasClone: true,
    workspaces: [],
    skills: [skill("review", true), skill("deploy", false)],
    refusedSkills: [{ plugin: "broken", vendor: "codex", reason: "no manifest" }],
    canWriteLibrary: true,
    writeLibraryReason: null,
    libraryDivergence: null,
    libraryInterruption: null,
    error: null,
  } as TeamStatus;
}

function openTeamPage() {
  useLicense.setState({ info: LICENSE, loaded: true } as never);
  setTeamAllowed(true);
  useWorkspaces.setState({
    workspaces: [{ id: "ws-1", name: "atelier", cwd: "/repo/atelier" } as Workspace],
    activeId: "ws-1",
  } as never);
  act(() => useUi.getState().setSettingsOverlayOpen(true));
  return renderUi(<TeamPage scope="team" />, {
    fixtures: {
      team_status: teamStatus,
      team_refresh: teamStatus,
      // OB-9: a refresh asks the work mode again (a clone is a team signal).
      team_work_mode: { mode: "team", chosen: true },
    },
  });
}

describe("Settings › Members and library links to the Library (UX-9.5)", () => {
  it("counts the team's skills in one row and lists none of them", async () => {
    openTeamPage();
    await screen.findByText(/Member of/);
    expect(screen.getByRole("heading", { name: "Library" })).toBeTruthy();
    expect(screen.getByText("1 in both CLIs · 1 in one only")).toBeTruthy();
    // No skill row, no `Remove from team` here any more.
    expect(screen.queryByText("review")).toBeNull();
    expect(screen.queryByText("deploy")).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove from team" })).toBeNull();
    // The refused plugin is still said, where it can be seen.
    expect(screen.getByText("broken")).toBeTruthy();
    expect(screen.getByText("Not loaded — no manifest.")).toBeTruthy();
  });

  it("opens the Library on the Team scope and closes Settings", async () => {
    const { user } = openTeamPage();
    await screen.findByText(/Member of/);
    await user.click(screen.getByRole("button", { name: "Team skills" }));
    await waitFor(() => expect(useUi.getState().settingsOverlayOpen).toBe(false));
    const library = useLibrary.getState().byWorkspace["ws-1"];
    expect(library?.page).toBe("skills");
    expect(library?.scope).toBe("team");
    expect(useUi.getState().centerMode["ws-1"]).toBe("library");
  });
});
