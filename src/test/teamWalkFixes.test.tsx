// Team walk 2026-10-01 (segment A, Mac owner): the Settings › Team fixes.
//
// - F1: once the team exists the owner can still give it a workspace — the
//   GitHub-backed workspaces open here, or any owner/name — and is told to
//   run Review access for the members already in.
// - F2: after Send invites Members says the invitation left and what the
//   invitee does next, until the next read from GitHub; Copy invite is in
//   Members too and shows the code it copied.
// - F7/F8: Create team waits while the account is read, without an error;
//   once created, the page reads the team from GitHub at once.
// - F5: with no team, the row is "Join or create a team", and "I have an
//   invite code" opens Setup › Team on Join, where the code is pasted.
import { describe, expect, it } from "vitest";
import { TeamPage } from "../components/settings/TeamPage";
import type { LicenseInfo, TeamStatus } from "../ipc";
import { DEFAULT_SETTINGS } from "../lib/settingsShape";
import { useLicense } from "../store/licenseStore";
import { useSetup } from "../store/setupStore";
import { useSettingsFlow } from "../store/settingsFlowStore";
import { renderUi, screen, waitFor, within } from "./render";
import { setTeamAllowed } from "./planGates";

const LICENSE = {
  status: "valid",
  team: "Plyloft test team",
  teamRepo: "owner/test-team",
} as unknown as LicenseInfo;

function ownerStatus(over: Partial<TeamStatus> = {}): TeamStatus {
  return {
    teamRepo: "owner/test-team",
    teamName: "Plyloft test team",
    ownerLogin: "owner",
    members: [
      { login: "owner", owner: true },
      { login: "friend", owner: false },
    ],
    isOwner: true,
    ignoredRepos: [],
    login: "owner",
    membership: "member",
    membershipReason: null,
    membershipStale: false,
    cloneRoot: "/Users/me/code",
    cloneRootIsDefault: true,
    hasClone: true,
    workspaces: [],
    skills: [],
    refusedSkills: [],
    canWriteLibrary: true,
    writeLibraryReason: null,
    libraryDivergence: null,
    libraryInterruption: null,
    error: null,
    ...over,
  } as TeamStatus;
}

function openOwnerPage(fixtures: Record<string, unknown> = {}) {
  useLicense.setState({ info: LICENSE, loaded: true } as never);
  setTeamAllowed(true);
  return renderUi(<TeamPage scope="team" />, {
    fixtures: {
      team_status: () => ownerStatus(),
      team_refresh: () => ownerStatus(),
      team_work_mode: { mode: "team", chosen: true },
      team_member_states: { members: [], problems: [] },
      team_create_defaults: {
        login: "owner",
        workspaces: [
          { repo: "owner/sandbox", name: "ghpr" },
          { repo: "owner/test-team", name: "the team clone" },
        ],
      },
      ...fixtures,
    },
  });
}

// QoL 14.4 (G25): the owner takes a workspace off the team's list; the
// confirm says what stays.
describe("QoL 14.4: removing a team workspace", () => {
  it("is the row's ⋯ for the owner, confirmed, through the team's list only", async () => {
    const removed: string[] = [];
    const listed = ownerStatus({
      workspaces: [{ repo: "owner/sandbox", name: "ghpr", registered: false, cloned: false, localPath: "/Users/me/code/sandbox", conflict: null }],
    } as never);
    const { user } = openOwnerPage({
      team_status: () => listed,
      team_refresh: () => listed,
      team_workspace_list_remove: ({ repo }: { repo: string }) => {
        removed.push(repo);
        return true;
      },
    });
    await user.click(await screen.findByRole("button", { name: "More for ghpr" }));
    await user.click(screen.getByRole("menuitem", { name: "Remove from the team workspaces…" }));
    expect(screen.getByText(/Their clones and workspaces stay on their computers/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Remove from the team" }));
    await waitFor(() => expect(removed).toEqual(["owner/sandbox"]));
  });
});

describe("F1: the owner gives the team a workspace after it exists", () => {
  it("offers this Mac's GitHub workspaces and any owner/name, then offers Give everyone access", async () => {
    const added: string[] = [];
    const applied: string[] = [];
    const { user } = openOwnerPage({
      team_workspace_list_add: ({ repo }: { repo: string }) => {
        added.push(repo);
        return true;
      },
      // QoL 14.4 (G24): every member's plan, read through Review access's own command.
      team_invite_plan: ({ login }: { login: string }) => ({
        login,
        teamName: "Plyloft test team",
        steps: [
          { repo: "owner/sandbox", kind: "workspace", permission: "push", current: "none", action: "grant", invitationExpires: null, purpose: "" },
        ],
        addsToManifest: false,
        warnings: [],
        digest: `d-${login}`,
      }),
      team_invite_apply: ({ login, confirmed }: { login: string; confirmed: string }) => {
        applied.push(`${login}:${confirmed}`);
        return { login, listed: true, manifestWritten: false, invited: ["owner/sandbox"], alreadyHad: [], alreadyInvited: [], failed: [] };
      },
    });
    const section = (await screen.findByRole("heading", { name: "Give the team a workspace" }))
      .closest("section") as HTMLElement;
    const give = within(section);
    // The team repo is never offered as one of its own workspaces.
    await give.findByText("ghpr");
    expect(give.queryByText("the team clone")).toBeNull();

    await user.click(give.getAllByRole("button", { name: "Add" })[0]);
    await waitFor(() => expect(added).toEqual(["owner/sandbox"]));
    expect(
      await give.findByText(/owner\/sandbox is a team workspace\. Give everyone access so GitHub lets your member into it\./),
    ).toBeTruthy();
    await user.click(give.getByRole("button", { name: "Give everyone access" }));
    const review = (await screen.findByText("What each member gets")).closest("[data-ply-team-everyone-review]") as HTMLElement;
    expect(within(review).getByText("friend")).toBeTruthy();
    await user.click(within(review).getByRole("button", { name: "Send 1 grant" }));
    await waitFor(() => expect(applied).toEqual(["friend:d-friend"]));

    // Anything else, typed as owner/name.
    const field = give.getByRole("textbox", { name: "Another repository" });
    await user.type(field, "someone/elsewhere{Enter}");
    await waitFor(() => expect(added).toEqual(["owner/sandbox", "someone/elsewhere"]));
  });
});

describe("U31: a team project whose folder is gone", () => {
  it("Settings says so and offers Clone it again, not Open here", async () => {
    const listed = ownerStatus({
      workspaces: [{ repo: "owner/sandbox", name: "sandbox", registered: true, cloned: false, localPath: "/p/sandbox", conflict: null }],
    } as never);
    const r = openOwnerPage({
      team_status: () => listed,
      team_refresh: () => listed,
      team_workspace_add: { repo: "owner/sandbox", path: "/p/sandbox", name: "sandbox", cloned: true, registered: false, membershipFromCache: false },
    });
    const section = within((await screen.findByRole("heading", { name: "Team workspaces" })).closest("section") as HTMLElement);
    expect(await section.findByText("Its folder isn't where Plyloft left it")).toBeTruthy();
    expect(section.queryByText("Open here")).toBeNull();
    r.tauri.allowUnhandled();
    await r.user.click(section.getByRole("button", { name: "Clone it again" }));
    await waitFor(() => expect(r.tauri.callsOf("team_workspace_add")[0].args).toEqual({ repo: "owner/sandbox" }));
  });
});

describe("U31: a team project's folder that is there and isn't a repository", () => {
  it("says so, and offers no clone that would be refused", async () => {
    const listed = ownerStatus({
      workspaces: [{ repo: "owner/sandbox", name: "sandbox", registered: true, cloned: false, folderPresent: true, localPath: "/p/sandbox", conflict: null }],
    } as never);
    openOwnerPage({ team_status: () => listed, team_refresh: () => listed });
    const section = within((await screen.findByRole("heading", { name: "Team workspaces" })).closest("section") as HTMLElement);
    expect(await section.findByText("Its folder isn't a git repository")).toBeTruthy();
    expect(section.queryByRole("button", { name: "Clone it again" })).toBeNull();
  });
});

describe("U17: Send invites that fails", () => {
  it("says why under the plan, which stays open, and a second press clears it", async () => {
    const plan = {
      login: "friend2",
      teamName: "Plyloft test team",
      digest: "d1",
      addsToManifest: true,
      warnings: [],
      steps: [
        { repo: "owner/test-team", kind: "team_repo", permission: "push", current: "no access", action: "grant", purpose: "Read the team." },
      ],
    };
    let tries = 0;
    const { user } = openOwnerPage({
      team_invite_plan: plan,
      team_invite_apply: () => {
        tries += 1;
        if (tries === 1) throw new Error("Plyloft couldn't reach its server. Nothing was changed on GitHub.");
        return { login: "friend2", manifestWritten: true, invited: ["owner/test-team"], alreadyHad: [], failed: [] };
      },
    });
    const members = within(
      (await screen.findByRole("heading", { name: "Members" })).closest("section") as HTMLElement,
    );
    await user.type(members.getByRole("textbox", { name: "Add somebody" }), "friend2");
    await user.click(members.getByRole("button", { name: "Review" }));
    await user.click(await screen.findByRole("button", { name: "Send invites" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't add the member. ");
    expect(alert.textContent).toContain("Nothing was changed on GitHub.");
    expect(screen.getByRole("button", { name: "Send invites" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Send invites" }));
    await waitFor(() => expect(screen.queryByText(/Couldn't add the member/)).toBeNull());
  });

  it("a new Review clears the refusal of the last plan", async () => {
    const plan = {
      login: "friend2",
      teamName: "Plyloft test team",
      digest: "d1",
      addsToManifest: true,
      warnings: [],
      steps: [
        { repo: "owner/test-team", kind: "team_repo", permission: "push", current: "no access", action: "grant", purpose: "Read the team." },
      ],
    };
    const { user } = openOwnerPage({
      team_invite_plan: plan,
      team_invite_apply: () => {
        throw new Error("Nothing was changed on GitHub.");
      },
    });
    const members = within(
      (await screen.findByRole("heading", { name: "Members" })).closest("section") as HTMLElement,
    );
    await user.type(members.getByRole("textbox", { name: "Add somebody" }), "friend2");
    await user.click(members.getByRole("button", { name: "Review" }));
    await user.click(await screen.findByRole("button", { name: "Send invites" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Couldn't add the member");
    await user.click(members.getByRole("button", { name: "Review" }));
    await waitFor(() => expect(screen.queryByText(/Couldn't add the member/)).toBeNull());
  });
});

describe("F2: Members after Send invites", () => {
  it("keeps an inline line until the next refresh, and Copy invite shows its code", async () => {
    const plan = {
      login: "friend2",
      teamName: "Plyloft test team",
      digest: "d1",
      addsToManifest: true,
      warnings: [],
      steps: [
        {
          repo: "owner/test-team",
          kind: "team_repo",
          permission: "push",
          current: "no access",
          action: "grant",
          purpose: "Read the team.",
        },
      ],
    };
    const { user } = openOwnerPage({
      team_invite_plan: plan,
      team_invite_apply: {
        login: "friend2",
        manifestWritten: true,
        invited: ["owner/test-team"],
        alreadyHad: [],
        failed: [],
      },
      team_invite_code: {
        code: "ply-join:owner/test-team",
        message: "Join Plyloft test team.\nply-join:owner/test-team\n",
      },
    });
    const members = within(
      (await screen.findByRole("heading", { name: "Members" })).closest("section") as HTMLElement,
    );
    await user.type(members.getByRole("textbox", { name: "Add somebody" }), "friend2");
    await user.click(members.getByRole("button", { name: "Review" }));
    await user.click(await screen.findByRole("button", { name: "Send invites" }));
    const line = "Invitation sent to friend2.";
    expect(await members.findByText(line)).toBeTruthy();

    await user.click(members.getByRole("button", { name: "Copy invite" }));
    expect(await members.findByText("ply-join:owner/test-team")).toBeTruthy();
    expect(await navigator.clipboard.readText()).toContain("ply-join:owner/test-team");

    // The next read from GitHub takes the line away: by then Review access
    // answers for what GitHub says.
    await user.click(screen.getByRole("button", { name: "Read it again" }));
    await waitFor(() => expect(screen.queryByText(line)).toBeNull());
  });
});

describe("F5: Join or create a team", () => {
  it("offers an invite code, which opens Setup › Team on Join", async () => {
    useLicense.setState({
      info: { ...LICENSE, team: null, teamRepo: null, status: "none" },
      loaded: true,
    } as never);
    setTeamAllowed(false);
    const noTeam = () => ({ teamRepo: null }) as unknown as TeamStatus;
    const { user } = renderUi(<TeamPage scope="team" />, {
      fixtures: { team_status: noTeam, team_refresh: noTeam },
    });
    expect(await screen.findByText("Join or create a team")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Start" }));
    expect(screen.getByRole("heading", { name: "Join or create a team" })).toBeTruthy();
    await user.click(screen.getByRole("radio", { name: /I have an invite code/ }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    const setup = useSetup.getState();
    expect(setup.open).toBe(true);
    expect(setup.step).toBe("team");
    expect(setup.teamPath).toBe("join");
    expect(useSettingsFlow.getState().flow).toBeNull();
  });
});

describe("F7/F8: creating a team", () => {
  it("waits for the account without an error, then reads the new team from GitHub at once", async () => {
    useLicense.setState({
      info: { ...LICENSE, team: null, teamRepo: null, status: "none" },
      loaded: true,
    } as never);
    setTeamAllowed(false);
    let created = false;
    let answerDefaults: (value: unknown) => void = () => {};
    const { user, tauri } = renderUi(<TeamPage scope="team" />, {
      fixtures: {
        // The local read never names the team here, so only a read with the
        // network (team_refresh) can draw it: the page must ask for one.
        team_status: () => ({ teamRepo: null }),
        team_refresh: () => ownerStatus(),
        team_work_mode: { mode: "team", chosen: true },
        team_member_states: { members: [], problems: [] },
        // Launch T1: a Team owner with no repository yet (paid, or comp).
        team_billing_get: { stage: { stage: "create", comp: true }, team: null, error: null },
        team_create_defaults: () => new Promise((resolve) => (answerDefaults = resolve)),
        settings_get: () => ({
          ...DEFAULT_SETTINGS,
          team: { ...DEFAULT_SETTINGS.team, teamRepo: created ? "owner/test-team" : null },
        }),
        team_create: ({ name }: { name: string }) => {
          created = true;
          return {
            name,
            repo: "owner/test-team",
            clonePath: "/x",
            alreadyExisted: false,
          };
        },
      },
    });
    await user.click(await screen.findByRole("button", { name: "Start" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.type(await screen.findByRole("textbox", { name: "Team name" }), "Plyloft test team");
    // F7: reading, not failing.
    expect(screen.getByText("Reading your GitHub account…")).toBeTruthy();
    expect(screen.queryByText(/could not read your GitHub/)).toBeNull();
    const create = screen.getByRole("button", { name: "Create team" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);

    answerDefaults({ login: "owner", workspaces: [] });
    await waitFor(() => expect(create.disabled).toBe(false));
    expect(tauri.callsOf("team_refresh")).toHaveLength(0);
    await user.click(create);
    // F8: the page reads the team with the network straight away.
    await waitFor(() => expect(tauri.callsOf("team_refresh").length).toBeGreaterThan(0));
  });
});
