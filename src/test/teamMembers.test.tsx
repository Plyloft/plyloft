// N14 (items 1, 3 and 9): Settings › Team › Members.
//
// - Each member reads Joined, Invited · expires <day> or No access, from
//   GitHub, after the page's read of the team from GitHub (never before it).
// - The invite review shows an invitation already waiting as "invited", not
//   a grant to send again.
// - Remove from team: a confirmation sheet naming the person and every
//   repository and saying what happens to their claims; the result names
//   what failed and that they stay in the team until every repo is done.
import { describe, expect, it } from "vitest";
import { TeamPage } from "../components/settings/TeamPage";
import type { LicenseInfo, MemberStates, RemoveOutcome, TeamStatus } from "../ipc";
import { useLicense } from "../store/licenseStore";
import { useSetup } from "../store/setupStore";
import { useToasts } from "../store/toastStore";
import { act, renderUi, screen, waitFor, within } from "./render";
import { setTeamAllowed } from "./planGates";
import { DEFAULT_SETTINGS, useSettings } from "../store/settingsStore";

const LICENSE = {
  status: "valid",
  team: "Plyloft test team",
  teamRepo: "owner/test-team",
} as unknown as LicenseInfo;

function ownerStatus(): TeamStatus {
  return {
    teamRepo: "owner/test-team",
    teamName: "Plyloft test team",
    ownerLogin: "owner",
    members: [
      { login: "owner", owner: true },
      { login: "joined", owner: false },
      { login: "invited", owner: false },
      { login: "lapsed", owner: false },
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
    workspaces: [
      {
        repo: "owner/sandbox",
        name: "sandbox",
        localPath: "/Users/me/code/sandbox",
        cloned: false,
        registered: false,
        conflict: null,
      },
    ],
    skills: [],
    refusedSkills: [],
    canWriteLibrary: true,
    writeLibraryReason: null,
    libraryDivergence: null,
    libraryInterruption: null,
    error: null,
  } as unknown as TeamStatus;
}

const STATES: MemberStates = {
  members: [
    {
      login: "owner",
      owner: true,
      state: "joined",
      invitationExpires: null,
      invitationExpired: null,
      workspacesInvited: [],
      workspacesMissing: [],
    },
    {
      login: "joined",
      owner: false,
      state: "joined",
      invitationExpires: null,
      invitationExpired: null,
      workspacesInvited: [],
      workspacesMissing: ["owner/sandbox"],
    },
    {
      login: "invited",
      owner: false,
      state: "invited",
      invitationExpires: "2026-10-09",
      invitationExpired: null,
      workspacesInvited: [],
      workspacesMissing: [],
    },
    {
      login: "lapsed",
      owner: false,
      state: "no_access",
      invitationExpires: null,
      invitationExpired: "2026-09-08",
      workspacesInvited: [],
      workspacesMissing: [],
    },
  ],
  problems: [],
  // The backend's list (P3-6) — here one more than the page's status knows.
  repos: ["owner/test-team", "owner/sandbox", "owner/third"],
};

function openOwnerPage(fixtures: Record<string, unknown> = {}) {
  useLicense.setState({ info: LICENSE, loaded: true } as never);
  setTeamAllowed(true);
  // Launch G3: the team this Mac is in is the setting (a key never names it).
  useSettings.setState({
    settings: { ...DEFAULT_SETTINGS, team: { ...DEFAULT_SETTINGS.team, teamRepo: "owner/test-team" } },
    loaded: true,
  } as never);
  return renderUi(<TeamPage scope="team" />, {
    fixtures: {
      team_status: () => ownerStatus(),
      team_refresh: () => ownerStatus(),
      team_work_mode: { mode: "team", chosen: true },
      team_create_defaults: { login: "owner", workspaces: [] },
      team_member_states: STATES,
      ...fixtures,
    },
  });
}

async function membersSection() {
  return within(
    (await screen.findByRole("heading", { name: "Members" })).closest("section") as HTMLElement,
  );
}

describe("Members: Joined, Invited, No access", () => {
  it("reads each member's state after the read from GitHub", async () => {
    const { tauri } = openOwnerPage();
    const members = await membersSection();
    expect(await members.findByText("Invited · expires 9 Oct")).toBeTruthy();
    expect(members.getByText("Joined")).toBeTruthy();
    expect(members.getByText("No access")).toBeTruthy();
    expect(
      members.getByText(
        "Joined the team repository. No access to owner/sandbox yet — press Review access to invite them.",
      ),
    ).toBeTruthy();
    expect(
      members.getByText("Invited until 9 Oct. Send them the code from Copy invite: they paste it in Plyloft, which accepts the invitation for them."),
    ).toBeTruthy();
    expect(
      members.getByText(
        "Listed in the team, but their invitation expired on 8 Sep. Press Review access to invite them again.",
      ),
    ).toBeTruthy();
    // Only after the network read: one ask, not one per local read too.
    expect(tauri.callsOf("team_refresh").length).toBeGreaterThan(0);
    expect(tauri.callsOf("team_member_states")).toHaveLength(1);
  });

  it("says GitHub couldn't be read without calling anyone 'No access'", async () => {
    openOwnerPage({
      team_member_states: () => {
        throw new Error("HTTP 403: Must have admin rights");
      },
    });
    const members = await membersSection();
    expect(
      await members.findByText(/couldn't read who has joined from GitHub: .*Must have admin rights/),
    ).toBeTruthy();
    expect(members.queryByText("No access")).toBeNull();
  });

  describe("the last known chip during a read", () => {
    const joinedRow = (members: ReturnType<typeof within>) =>
      members.getByText("joined").closest(".ux-row") as HTMLElement;
    const withJoined = (state: MemberStates["members"][number]["state"]): MemberStates => ({
      ...STATES,
      members: STATES.members.map((m) => (m.login === "joined" ? { ...m, state } : m)),
    });

    it("stays while Read it again reads, and a read that changes it updates it", async () => {
      let finishRefresh: (status: TeamStatus) => void = () => {};
      let states = STATES;
      let refreshes = 0;
      const { user } = openOwnerPage({
        team_refresh: () => {
          refreshes += 1;
          if (refreshes === 1) return ownerStatus();
          return new Promise<TeamStatus>((resolve) => {
            finishRefresh = resolve;
          });
        },
        team_member_states: () => states,
      });
      const members = await membersSection();
      await waitFor(() => expect(within(joinedRow(members)).getByText("Joined")).toBeTruthy());
      await user.click(await screen.findByRole("button", { name: "Read it again" }));
      await screen.findByRole("button", { name: "Reading…" });
      expect(within(joinedRow(members)).getByText("Joined")).toBeTruthy();
      states = withJoined("no_access");
      act(() => finishRefresh(ownerStatus()));
      await waitFor(() => expect(within(joinedRow(members)).getByText("No access")).toBeTruthy());
      expect(within(joinedRow(members)).queryByText("Joined")).toBeNull();
    });

    it("is there when the page opens again, before GitHub answers", async () => {
      const first = openOwnerPage();
      const members = await membersSection();
      await waitFor(() => expect(within(joinedRow(members)).getByText("Joined")).toBeTruthy());
      first.unmount();

      let finishRefresh: (status: TeamStatus) => void = () => {};
      openOwnerPage({
        team_refresh: () =>
          new Promise<TeamStatus>((resolve) => {
            finishRefresh = resolve;
          }),
        team_member_states: () => {
          throw new Error("HTTP 502");
        },
      });
      const again = await membersSection();
      await screen.findByRole("button", { name: "Reading…" });
      expect(within(joinedRow(again)).getByText("Joined")).toBeTruthy();
      // A read that fails says so as before; the chip stays the last known.
      act(() => finishRefresh(ownerStatus()));
      expect(await again.findByText(/couldn't read who has joined from GitHub: .*HTTP 502/)).toBeTruthy();
      expect(within(joinedRow(again)).getByText("Joined")).toBeTruthy();
    });

    it("a read answered from the clone asks no states, so remembered chips don't stand with no caveat", async () => {
      const first = openOwnerPage();
      const members = await membersSection();
      await waitFor(() => expect(within(joinedRow(members)).getByText("Joined")).toBeTruthy());
      const asked = first.tauri.callsOf("team_member_states").length;
      first.unmount();

      const { tauri } = openOwnerPage({
        team_refresh: () => ({ ...ownerStatus(), membershipStale: true }),
      });
      const again = await membersSection();
      await screen.findByRole("button", { name: "Read it again" });
      expect(tauri.callsOf("team_member_states")).toHaveLength(asked);
      expect(within(joinedRow(again)).queryByText("Joined")).toBeNull();
    });

    it("the Remove sheet lists the status's repositories as well as the remembered ones", async () => {
      const first = openOwnerPage();
      const members = await membersSection();
      await waitFor(() => expect(within(joinedRow(members)).getByText("Joined")).toBeTruthy());
      first.unmount();

      const fresh = ownerStatus();
      fresh.workspaces = [...fresh.workspaces, { ...fresh.workspaces[0], repo: "owner/added-since", name: "added-since" }];
      const { user } = openOwnerPage({
        team_status: () => fresh,
        team_refresh: () => new Promise<TeamStatus>(() => {}),
      });
      const again = await membersSection();
      await screen.findByRole("button", { name: "Reading…" });
      await user.click(await again.findByRole("button", { name: "More for joined" }));
      await user.click(await screen.findByRole("menuitem", { name: "Remove from team…" }));
      const sheet = within(await screen.findByRole("dialog"));
      expect(sheet.getByText(/4 repositories/)).toBeTruthy();
    });
  });

  it("an Invited row names the team repository's invitation as well as the workspace's", async () => {
    openOwnerPage({
      team_member_states: {
        ...STATES,
        members: [
          {
            login: "joined",
            owner: false,
            state: "invited",
            invitationExpires: "2026-11-10",
            invitationExpired: null,
            workspacesInvited: ["owner/sandbox"],
            workspacesMissing: [],
          },
        ],
      },
    });
    const members = await membersSection();
    expect(await members.findByText(/Invitations to owner\/test-team and owner\/sandbox wait on them\./)).toBeTruthy();
  });

  it("shows an invitation already waiting as invited, not a grant to send again", async () => {
    const { user } = openOwnerPage({
      team_invite_plan: {
        login: "invited",
        teamName: "Plyloft test team",
        digest: "",
        addsToManifest: false,
        warnings: [],
        steps: [
          {
            repo: "owner/test-team",
            kind: "team_repo",
            permission: "push",
            current: "a pending invitation",
            action: "invited",
            invitationExpires: "2026-10-09",
            purpose: "Read the team.",
          },
        ],
      },
    });
    const members = await membersSection();
    await members.findByText("Invited · expires 9 Oct");
    const row = members.getByText("invited").closest(".ux-row") as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "Review access" }));
    expect(await screen.findByText("invited · expires 9 Oct")).toBeTruthy();
    expect(
      screen.getByText(
        "invited is in Plyloft test team. An invitation waits on them; nothing to send. Send them the code from Copy invite: they paste it in Plyloft, which accepts the invitation for them.",
      ),
    ).toBeTruthy();
    // Nothing to send: the sheet offers no add, only the way out.
    expect(screen.getByText("Review access", { selector: ".ux-flow-eyebrow" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "invited in Plyloft test team" })).toBeTruthy();
    expect(screen.queryByText(/Add a member/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Add to the team" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText(/nothing to send/)).toBeNull();
  });

  it("somebody new who has access everywhere can still be added to the team's list", async () => {
    const { user } = openOwnerPage({
      team_invite_plan: {
        login: "newcomer",
        teamName: "Plyloft test team",
        digest: "",
        addsToManifest: true,
        warnings: [],
        steps: [
          {
            repo: "owner/test-team",
            kind: "team_repo",
            permission: "push",
            current: "write access",
            action: "already_has",
            invitationExpires: null,
            purpose: "Read the team.",
          },
        ],
      },
    });
    const members = await membersSection();
    await user.type(members.getByRole("textbox", { name: "Add somebody" }), "newcomer");
    await user.click(members.getByRole("button", { name: "Review" }));
    expect(await screen.findByText("Add a member · 1 step")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Add to the team" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("Add somebody: a login with no GitHub account", () => {
  const ghostStep = {
    repo: "owner/test-team",
    kind: "team_repo",
    permission: "push",
    current: "no account",
    action: "no_such_account",
    invitationExpires: null,
    purpose: "Read the team.",
  };
  const ghost = { login: "nobody", teamName: "Plyloft test team", digest: "", addsToManifest: true, warnings: [], steps: [ghostStep] };

  it("says so, in its own words, with nothing to send", async () => {
    const { user } = openOwnerPage({ team_invite_plan: ghost });
    const members = await membersSection();
    await user.type(members.getByRole("textbox", { name: "Add somebody" }), "nobody");
    await user.click(members.getByRole("button", { name: "Review" }));
    expect(await screen.findByText("no GitHub account with this name")).toBeTruthy();
    expect(screen.getByText("GitHub has no account named nobody. Check the spelling; Plyloft sends nothing.")).toBeTruthy();
    expect(screen.queryByText("could not check — read it again")).toBeNull();
    expect(screen.queryByText(/GitHub gives them/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Add to the team" })).toBeNull();
    const send = screen.getByRole("button", { name: "Send invites" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
  });

  it("Cancel keeps a name GitHub doesn't know, to fix a typo", async () => {
    const { user } = openOwnerPage({ team_invite_plan: { ...ghost, login: "Nobody" } });
    const members = await membersSection();
    const field = members.getByRole("textbox", { name: "Add somebody" }) as HTMLInputElement;
    await user.type(field, "nobody");
    await user.click(members.getByRole("button", { name: "Review" }));
    await screen.findByText("no GitHub account with this name");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("no GitHub account with this name")).toBeNull();
    expect(field.value).toBe("nobody");
  });

  it("Cancel clears the field for a name GitHub knows, whatever the case it spells it in", async () => {
    const steps = ghost.steps.map((step) => ({ ...step, action: "grant" as const }));
    const { user } = openOwnerPage({ team_invite_plan: { ...ghost, login: "Nobody", steps } });
    const members = await membersSection();
    const field = members.getByRole("textbox", { name: "Add somebody" }) as HTMLInputElement;
    await user.type(field, "nobody");
    await user.click(members.getByRole("button", { name: "Review" }));
    await screen.findByRole("button", { name: "Send invites" });
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(field.value).toBe("");
    expect((members.getByRole("button", { name: "Review" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("Cancel on a row's Review access leaves what's being typed", async () => {
    const { user } = openOwnerPage({
      team_invite_plan: ({ login }: { login: string }) => ({ ...ghost, login, steps: [{ ...ghostStep, current: "no access", action: "grant" }] }),
    });
    const members = await membersSection();
    await members.findByText("Invited · expires 9 Oct");
    const field = members.getByRole("textbox", { name: "Add somebody" }) as HTMLInputElement;
    await user.type(field, "half-typed");
    const row = members.getByText("invited").closest(".ux-row") as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "Review access" }));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(field.value).toBe("half-typed");
  });

  it("doesn't stop Give everyone access for the others, and sends only them", async () => {
    const applied: string[] = [];
    const grant = { ...ghostStep, current: "no access", action: "grant" };
    const { user } = openOwnerPage({
      team_invite_plan: ({ login }: { login: string }) =>
        login === "lapsed" ? { ...ghost, login } : { ...ghost, login, digest: "x", addsToManifest: false, steps: [login === "joined" ? grant : { ...grant, action: "already_has" }] },
      team_invite_apply: ({ login }: { login: string }) => {
        applied.push(login);
        return { login, listed: true, manifestWritten: false, invited: ["owner/test-team"], alreadyHad: [], alreadyInvited: [], failed: [] };
      },
    });
    const members = await membersSection();
    await user.click(await members.findByRole("button", { name: "Give everyone access" }));
    expect(await screen.findByText("no GitHub account with this name")).toBeTruthy();
    expect(screen.getByText(/GitHub has no account named lapsed\./)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Send 1 grant" }));
    await waitFor(() => expect(applied).toEqual(["joined"]));
  });
});

describe("Remove from team", () => {
  const done: RemoveOutcome = {
    login: "joined",
    removed: ["owner/test-team", "owner/sandbox"],
    cancelledInvitations: [],
    stillRead: [],
    failed: [],
    manifestUpdated: true,
    manifestError: null,
  };

  it("is never offered for the owner", async () => {
    openOwnerPage();
    const members = await membersSection();
    await members.findByText("Joined");
    expect(members.queryByRole("button", { name: "More for owner" })).toBeNull();
    expect(members.getByRole("button", { name: "More for joined" })).toBeTruthy();
  });

  it("asks first, naming the person, every repository and their claims, then removes", async () => {
    const asked: string[] = [];
    const { user } = openOwnerPage({
      team_member_remove: ({ login }: { login: string }) => {
        asked.push(login);
        return done;
      },
    });
    const members = await membersSection();
    await user.click(await members.findByRole("button", { name: "More for joined" }));
    await user.click(await screen.findByRole("menuitem", { name: "Remove from team…" }));
    const sheet = within(await screen.findByRole("dialog"));
    expect(sheet.getByText("Remove joined from Plyloft test team?")).toBeTruthy();
    expect(sheet.getByText(/joined's access to the 3 repositories below/)).toBeTruthy();
    expect(sheet.getByText("owner/test-team")).toBeTruthy();
    expect(sheet.getByText("owner/sandbox")).toBeTruthy();
    expect(sheet.getByText("owner/third")).toBeTruthy();
    // U14: as GitHub really behaves.
    expect(sheet.getByText(/If GitHub no longer gives joined access, it takes them off their issues/)).toBeTruthy();
    // The safe way out has the focus; nothing ran yet.
    await waitFor(() =>
      expect(document.activeElement).toBe(sheet.getByRole("button", { name: "Cancel" })),
    );
    expect(asked).toEqual([]);

    await user.click(sheet.getByRole("button", { name: "Remove from team" }));
    await waitFor(() => expect(asked).toEqual(["joined"]));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(
      await members.findByText(
        "joined removed from the team. No write access to owner/test-team and owner/sandbox any more, and the team no longer lists them.",
      ),
    ).toBeTruthy();
  });

  it("names the repositories that failed and keeps them in the team", async () => {
    const { user } = openOwnerPage({
      team_member_remove: {
        ...done,
        removed: ["owner/test-team"],
        failed: ["owner/sandbox: GitHub refused to remove them (HTTP 403)"],
        manifestUpdated: false,
      },
    });
    const members = await membersSection();
    await user.click(await members.findByRole("button", { name: "More for joined" }));
    await user.click(await screen.findByRole("menuitem", { name: "Remove from team…" }));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Remove from team" }),
    );
    const line = await members.findByText(/^joined is still in the team\./);
    expect(line.textContent).toContain("Not done on: owner/sandbox: GitHub refused to remove them (HTTP 403)");
    expect(line.textContent).toContain("Their access to owner/test-team is gone.");
    expect(line.textContent).toContain("press Remove from team again, it is safe");
  });

  it("their access gone and team.json refused: the row says No access while the read is out, and if it fails", async () => {
    let reads = 0;
    const { user } = openOwnerPage({
      team_member_states: () => {
        reads += 1;
        if (reads === 1) return STATES;
        // The read after Remove: GitHub's trouble, the walk's 500 passing.
        throw new Error("HTTP 502");
      },
      team_member_remove: {
        ...done,
        manifestUpdated: false,
        manifestError: "GitHub didn't take the change to team.json. The team's member list is as it was. Try again.",
      },
    });
    const members = await membersSection();
    const row = () => (members.getByText("joined").closest(".ux-row") as HTMLElement);
    await waitFor(() => expect(within(row()).getByText("Joined")).toBeTruthy());
    await user.click(await members.findByRole("button", { name: "More for joined" }));
    await user.click(await screen.findByRole("menuitem", { name: "Remove from team…" }));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Remove from team" }),
    );
    await members.findByText(/^joined is still listed in the team\./);
    expect(within(row()).getByText("No access")).toBeTruthy();
    expect(within(row()).queryByText("Joined")).toBeNull();
    expect(
      await members.findByText(/couldn't read who has joined from GitHub: .*HTTP 502/),
    ).toBeTruthy();
    expect(within(row()).getByText("No access")).toBeTruthy();
  });
});

describe("A Remove that got as far as their access", () => {
  const HINT = "Their access is gone, but the team still lists them. Remove from team again to finish.";
  const refused: RemoveOutcome = {
    login: "joined",
    removed: ["owner/test-team", "owner/sandbox"],
    cancelledInvitations: [],
    stillRead: [],
    failed: [],
    manifestUpdated: false,
    manifestError: "GitHub didn't take the change to team.json. The team's member list is as it was. Try again.",
  };
  const goneStates = (): MemberStates => ({
    ...STATES,
    members: STATES.members.map((m) =>
      m.login === "joined" ? { ...m, state: "no_access", workspacesMissing: ["owner/sandbox"] } : m,
    ),
  });
  const rowOf = (members: ReturnType<typeof within>, login: string) =>
    members.getByText(login).closest(".ux-row") as HTMLElement;

  async function pressRemove(user: { click: (el: Element) => Promise<void> }, members: ReturnType<typeof within>) {
    await user.click(await members.findByRole("button", { name: "More for joined" }));
    await user.click(await screen.findByRole("menuitem", { name: "Remove from team…" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Remove from team" }));
    await members.findByText(/^joined is still listed in the team\./);
  }

  it("says so with Remove as its action, through a read and a reopen, and finishes on the second Remove", async () => {
    let states = STATES;
    let removes = 0;
    const page = openOwnerPage({
      team_member_states: () => states,
      team_member_remove: () => {
        removes += 1;
        if (removes === 1) {
          states = goneStates();
          return refused;
        }
        return { ...refused, manifestUpdated: true, manifestError: null };
      },
    });
    const members = await membersSection();
    await members.findByText("Joined");
    await pressRemove(page.user, members);
    const row = within(rowOf(members, "joined"));
    await row.findByText(HINT);
    expect(row.getByText("No access")).toBeTruthy();
    expect(row.getByRole("button", { name: "Remove from team…" })).toBeTruthy();
    expect(row.queryByRole("button", { name: "Give a seat" })).toBeNull();
    // An ordinary No access row keeps its words and its action.
    const lapsed = within(rowOf(members, "lapsed"));
    expect(lapsed.getByText(/their invitation expired/)).toBeTruthy();
    expect(lapsed.queryByRole("button", { name: "Remove from team…" })).toBeNull();
    expect(lapsed.getByRole("button", { name: "Review access" })).toBeTruthy();

    // A read that lands, then the page opened again before GitHub answers.
    await page.user.click(screen.getByRole("button", { name: "Read it again" }));
    await waitFor(() => expect(page.tauri.callsOf("team_member_states").length).toBeGreaterThan(1));
    await row.findByText(HINT);
    page.unmount();
    const again = openOwnerPage({
      team_refresh: () => new Promise<TeamStatus>(() => {}),
      team_member_remove: () => ({ ...refused, manifestUpdated: true, manifestError: null }),
      team_member_states: () => states,
    });
    const reopened = await membersSection();
    const back = within(rowOf(reopened, "joined"));
    expect(await back.findByText(HINT)).toBeTruthy();

    // The second Remove: the same sheet, and the row goes as usual.
    await again.user.click(back.getByRole("button", { name: "Remove from team…" }));
    await again.user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Remove from team" }));
    await reopened.findByText(/^joined removed from the team\./);
    expect(reopened.queryByText(HINT)).toBeNull();
  });

  it("goes when a read says they have access or an invitation again", async () => {
    let states = STATES;
    const page = openOwnerPage({
      team_member_states: () => states,
      team_member_remove: () => {
        states = goneStates();
        return refused;
      },
    });
    const members = await membersSection();
    await members.findByText("Joined");
    await pressRemove(page.user, members);
    await members.findByText(HINT);
    states = STATES;
    await page.user.click(screen.getByRole("button", { name: "Read it again" }));
    await within(rowOf(members, "joined")).findByText("Joined");
    expect(members.queryByText(HINT)).toBeNull();
  });

  it("stays when GitHub didn't answer for them, and goes when a read no longer lists them", async () => {
    let states = STATES;
    const page = openOwnerPage({
      team_member_states: () => states,
      team_member_remove: () => {
        states = goneStates();
        return refused;
      },
    });
    const members = await membersSection();
    await members.findByText("Joined");
    await pressRemove(page.user, members);
    await members.findByText(HINT);
    const reads = () => page.tauri.callsOf("team_member_states").length;
    const read = async () => {
      const before = reads();
      await page.user.click(screen.getByRole("button", { name: "Read it again" }));
      await waitFor(() => expect(reads()).toBeGreaterThan(before));
      await screen.findByRole("button", { name: "Read it again" });
    };
    states = {
      ...goneStates(),
      members: goneStates().members.map((m) => (m.login === "joined" ? { ...m, state: "unknown" } : m)),
      problems: ["owner/test-team: HTTP 502"],
    };
    await read();
    await members.findByText(/GitHub didn't answer for everything/);
    expect(members.getByText(HINT)).toBeTruthy();
    states = { ...STATES, members: STATES.members.filter((m) => m.login !== "joined") };
    await read();
    await waitFor(() => expect(members.queryByText(HINT)).toBeNull());
  });

  it("a Remove that failed on a repository isn't this: GitHub still has them there", async () => {
    let states = STATES;
    const page = openOwnerPage({
      team_member_states: () => states,
      team_member_remove: () => {
        states = goneStates();
        return { ...refused, removed: ["owner/test-team"], failed: ["owner/sandbox: GitHub refused"], manifestError: null };
      },
    });
    const members = await membersSection();
    await members.findByText("Joined");
    await page.user.click(await members.findByRole("button", { name: "More for joined" }));
    await page.user.click(await screen.findByRole("menuitem", { name: "Remove from team…" }));
    await page.user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Remove from team" }));
    await members.findByText(/^joined is still in the team\./);
    expect(members.queryByText(HINT)).toBeNull();
  });
});

describe("The result of Send invites and Remove from team", () => {
  const removed: RemoveOutcome = {
    login: "joined",
    removed: ["owner/test-team"],
    cancelledInvitations: [],
    stillRead: [],
    failed: [],
    manifestUpdated: true,
    manifestError: null,
  };
  const plan = {
    login: "newbie",
    teamName: "Plyloft test team",
    digest: "d1",
    addsToManifest: true,
    warnings: [],
    steps: [
      { repo: "owner/test-team", kind: "team_repo", permission: "push", current: "no access", action: "grant", purpose: "Read the team." },
    ],
  };
  const invited = {
    login: "newbie",
    listed: true,
    manifestWritten: true,
    invited: ["owner/test-team"],
    alreadyHad: [],
    alreadyInvited: [],
    failed: [],
  };
  const REMOVED = /joined removed from the team\./;
  const SENT = /Invitation sent to newbie\./;

  async function removeJoined(user: ReturnType<typeof openOwnerPage>["user"], members: Awaited<ReturnType<typeof membersSection>>) {
    await user.click(await members.findByRole("button", { name: "More for joined" }));
    await user.click(await screen.findByRole("menuitem", { name: "Remove from team…" }));
    const sheet = within(await screen.findByRole("dialog"));
    await user.click(sheet.getByRole("button", { name: "Remove from team" }));
    await members.findByText(REMOVED);
  }

  async function invite(user: ReturnType<typeof openOwnerPage>["user"], members: Awaited<ReturnType<typeof membersSection>>) {
    const field = members.getByRole("textbox", { name: "Add somebody" }) as HTMLInputElement;
    await user.type(field, "newbie");
    // Said here, so a failure names the letters and not a missing plan.
    expect(field.value).toBe("newbie");
    const review = members.getByRole("button", { name: "Review" }) as HTMLButtonElement;
    expect(review.disabled).toBe(false);
    await user.click(review);
    await user.click(await screen.findByRole("button", { name: "Send invites" }));
    await members.findByText(SENT);
  }

  it("Remove's result goes at the next press, and at Read it again", async () => {
    const { user } = openOwnerPage({ team_member_remove: removed, team_invite_plan: plan });
    const members = await membersSection();
    await removeJoined(user, members);
    await user.click(members.getAllByRole("button", { name: "Review access" })[0]);
    await waitFor(() => expect(members.queryByText(REMOVED)).toBeNull());

    await removeJoined(user, members);
    await user.click(screen.getByRole("button", { name: "Read it again" }));
    await waitFor(() => expect(members.queryByText(REMOVED)).toBeNull());
  });

  it("the newer result replaces the older, whichever came first", async () => {
    const { user } = openOwnerPage({ team_member_remove: removed, team_invite_plan: plan, team_invite_apply: invited });
    const members = await membersSection();
    await removeJoined(user, members);
    await invite(user, members);
    expect(members.queryByText(REMOVED)).toBeNull();
    await removeJoined(user, members);
    expect(members.queryByText(SENT)).toBeNull();
  });

  it("a send that invited nobody leaves no older result behind", async () => {
    const { user } = openOwnerPage({
      team_member_remove: removed,
      team_invite_plan: plan,
      team_invite_apply: { ...invited, invited: [], alreadyHad: ["owner/test-team"] },
    });
    const members = await membersSection();
    await removeJoined(user, members);
    await user.type(members.getByRole("textbox", { name: "Add somebody" }), "newbie");
    await user.click(members.getByRole("button", { name: "Review" }));
    await waitFor(() => expect(members.queryByText(REMOVED)).toBeNull());
    await user.click(await screen.findByRole("button", { name: "Send invites" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Send invites" })).toBeNull());
    expect(members.queryByText(REMOVED)).toBeNull();
    expect(members.queryByText(SENT)).toBeNull();
  });
});

describe("After Send invites, what they do next", () => {
  const NEXT = "Send them the code from Copy invite: they paste it in Plyloft, which accepts the invitation for them.";

  it("is said once, in the Invited row, and the result only says it left", async () => {
    let sent = false;
    const newbie = {
      login: "newbie",
      owner: false,
      state: "invited",
      invitationExpires: "2026-10-09",
      invitationExpired: null,
      workspacesInvited: [],
      workspacesMissing: [],
    };
    const others = STATES.members.filter((m) => m.login !== "invited");
    const { user } = openOwnerPage({
      team_status: () => {
        const status = ownerStatus();
        return sent ? { ...status, members: [...status.members, { login: "newbie", owner: false }] } : status;
      },
      team_member_states: () => ({ ...STATES, members: sent ? [...others, newbie] : others }),
      team_invite_plan: {
        login: "newbie",
        teamName: "Plyloft test team",
        digest: "d1",
        addsToManifest: true,
        warnings: [],
        steps: [{ repo: "owner/test-team", kind: "team_repo", permission: "push", current: "no access", action: "grant", purpose: "Read the team." }],
      },
      team_invite_apply: () => {
        sent = true;
        return { login: "newbie", listed: true, manifestWritten: true, invited: ["owner/test-team"], alreadyHad: [], alreadyInvited: [], failed: [] };
      },
    });
    const members = await membersSection();
    await user.type(members.getByRole("textbox", { name: "Add somebody" }), "newbie");
    await user.click(members.getByRole("button", { name: "Review" }));
    await user.click(await screen.findByRole("button", { name: "Send invites" }));
    expect(await members.findByText("Invitation sent to newbie.")).toBeTruthy();
    expect(await members.findByText(`Invited until 9 Oct. ${NEXT}`)).toBeTruthy();
    const section = (await screen.findByRole("heading", { name: "Members" })).closest("section") as HTMLElement;
    expect(section.textContent?.split(NEXT)).toHaveLength(2);
  });
});

describe("The header after a write", () => {
  const GIT_AUTH =
    'Could not pull the team repo: Git couldn\'t sign in to GitHub. In Settings › Setup and account › Setup › GitHub, turn on "Git uses your GitHub sign-in", then try again.';
  const LAST_ANSWER = /this is the last answer GitHub gave/;
  const removed: RemoveOutcome = {
    login: "joined",
    removed: ["owner/test-team"],
    cancelledInvitations: [],
    stillRead: [],
    failed: [],
    manifestUpdated: true,
    manifestError: null,
  };
  // As the backend answers: a local read always calls its verdict stale.
  const localRead = () => ({ ...ownerStatus(), membershipStale: true });

  async function remove(user: ReturnType<typeof openOwnerPage>["user"]) {
    const members = await membersSection();
    await user.click(await members.findByRole("button", { name: "More for joined" }));
    await user.click(await screen.findByRole("menuitem", { name: "Remove from team…" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Remove from team" }));
    await members.findByText(/joined removed from the team\./);
    return members;
  }

  it("a successful Remove doesn't call GitHub's answer stale", async () => {
    const { user, tauri } = openOwnerPage({ team_status: localRead, team_member_remove: removed });
    expect(await screen.findByText("Read just now")).toBeTruthy();
    const before = tauri.callsOf("team_status").length;
    await remove(user);
    await waitFor(() => expect(tauri.callsOf("team_status").length).toBeGreaterThan(before));
    await waitFor(() => expect(screen.getAllByText(/owned by owner/).length).toBeGreaterThan(0));
    expect(screen.queryByText(LAST_ANSWER)).toBeNull();
  });

  it("a read that failed still says so, and a write after it doesn't hide that", async () => {
    const { user, tauri } = openOwnerPage({
      team_status: localRead,
      team_refresh: () => ({ ...ownerStatus(), membershipStale: true, error: "Could not check access." }),
      team_member_remove: removed,
    });
    expect(await screen.findByText(LAST_ANSWER)).toBeTruthy();
    const before = tauri.callsOf("team_status").length;
    await remove(user);
    await waitFor(() => expect(tauri.callsOf("team_status").length).toBeGreaterThan(before));
    expect(await screen.findByText(LAST_ANSWER)).toBeTruthy();
  });

  it("a failed pull with an answering probe stays said after a write, until a read goes through", async () => {
    const PULL = "Could not pull the team repo: GitHub didn't answer in time.";
    let refresh: TeamStatus = { ...ownerStatus(), error: PULL };
    const { user, tauri } = openOwnerPage({
      team_status: localRead,
      team_refresh: () => refresh,
      team_member_remove: removed,
    });
    expect(await screen.findByText(PULL)).toBeTruthy();
    const before = tauri.callsOf("team_status").length;
    await remove(user);
    await waitFor(() => expect(tauri.callsOf("team_status").length).toBeGreaterThan(before));
    await act(async () => {});
    expect(screen.getByText(PULL)).toBeTruthy();
    refresh = ownerStatus();
    await user.click(screen.getByRole("button", { name: "Read it again" }));
    await waitFor(() => expect(screen.queryByText(PULL)).toBeNull());
  });

  it("after a write, closing Setup still reads again for a sign-in trouble the last read found", async () => {
    const { user, tauri } = openOwnerPage({
      team_status: localRead,
      team_refresh: () => ({ ...ownerStatus(), error: GIT_AUTH }),
      team_member_remove: removed,
    });
    await screen.findByRole("button", { name: "Read it again" });
    const before = tauri.callsOf("team_status").length;
    await remove(user);
    await waitFor(() => expect(tauri.callsOf("team_status").length).toBeGreaterThan(before));
    act(() => useSetup.setState({ open: true }));
    const reads = tauri.callsOf("team_refresh").length;
    act(() => useSetup.getState().closeSetup());
    await waitFor(() => expect(tauri.callsOf("team_refresh").length).toBe(reads + 1));
  });

  it("a read that threw doesn't leave the answer before it looking fresh", async () => {
    let fail = false;
    const { user, tauri } = openOwnerPage({
      team_status: localRead,
      team_refresh: () => {
        if (fail) throw new Error("network down");
        return ownerStatus();
      },
      team_member_remove: removed,
    });
    expect(await screen.findByText("Read just now")).toBeTruthy();
    fail = true;
    await user.click(screen.getByRole("button", { name: "Read it again" }));
    await waitFor(() => expect(screen.queryByText("Read just now")).toBeNull());
    const before = tauri.callsOf("team_status").length;
    await remove(user);
    await waitFor(() => expect(tauri.callsOf("team_status").length).toBeGreaterThan(before));
    expect(await screen.findByText(LAST_ANSWER)).toBeTruthy();
  });

  it("on open, the local read doesn't say it while GitHub is being asked", async () => {
    let answer: (s: TeamStatus) => void = () => {};
    openOwnerPage({
      team_status: localRead,
      team_refresh: () => new Promise<TeamStatus>((resolve) => (answer = resolve)),
    });
    await screen.findByRole("button", { name: "Reading…" });
    await waitFor(() => expect(screen.getAllByText(/owned by owner/).length).toBeGreaterThan(0));
    expect(screen.queryByText(LAST_ANSWER)).toBeNull();
    act(() => answer(ownerStatus()));
    expect(await screen.findByText("Read just now")).toBeTruthy();
    expect(screen.queryByText(LAST_ANSWER)).toBeNull();
  });
});

describe("A write while a read from GitHub is under way", () => {
  it("Read it again comes back when that read ends", async () => {
    let answer: (s: TeamStatus) => void = () => {};
    const { user } = openOwnerPage({
      team_refresh: () => new Promise<TeamStatus>((resolve) => (answer = resolve)),
      team_member_remove: {
        login: "joined",
        removed: ["owner/test-team"],
        cancelledInvitations: [],
        stillRead: [],
        failed: [],
        manifestUpdated: true,
        manifestError: null,
      },
    });
    const members = await membersSection();
    expect(await screen.findByRole("button", { name: "Reading…" })).toBeTruthy();
    await user.click(await members.findByRole("button", { name: "More for joined" }));
    await user.click(await screen.findByRole("menuitem", { name: "Remove from team…" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Remove from team" }));
    await members.findByText(/joined removed from the team\./);
    act(() => answer(ownerStatus()));
    const again = await screen.findByRole("button", { name: "Read it again" });
    expect((again as HTMLButtonElement).disabled).toBe(false);
  });

  const LAST_ANSWER = /this is the last answer GitHub gave/;
  const removed: RemoveOutcome = {
    login: "joined",
    removed: ["owner/test-team"],
    cancelledInvitations: [],
    stillRead: [],
    failed: [],
    manifestUpdated: true,
    manifestError: null,
  };
  // As the backend answers: a local read always calls its verdict stale.
  const localRead = () => ({ ...ownerStatus(), membershipStale: true });

  async function removeWhileReading(user: ReturnType<typeof openOwnerPage>["user"]) {
    const members = await membersSection();
    await user.click(await members.findByRole("button", { name: "More for joined" }));
    await user.click(await screen.findByRole("menuitem", { name: "Remove from team…" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Remove from team" }));
    await members.findByText(/joined removed from the team\./);
    return members;
  }

  it("that read went through: the header isn't stale, Read just now shows, states are read, the clone is read again", async () => {
    let answer: (s: TeamStatus) => void = () => {};
    let clone = localRead();
    const { user, tauri } = openOwnerPage({
      team_status: () => clone,
      team_refresh: () => new Promise<TeamStatus>((resolve) => (answer = resolve)),
      team_member_remove: removed,
    });
    const members = await removeWhileReading(user);
    await waitFor(() => expect(tauri.callsOf("team_member_states")).toHaveLength(1));
    expect(screen.queryByText(LAST_ANSWER)).toBeNull();
    // Its own status was read before the write, so it isn't what's shown; the
    // clone it left is, with a teammate's change its pull brought.
    clone = { ...localRead(), members: [...ownerStatus().members, { login: "teammate", owner: false }] } as TeamStatus;
    act(() =>
      answer({ ...ownerStatus(), members: [...ownerStatus().members, { login: "from-before", owner: false }] } as TeamStatus),
    );
    expect(await screen.findByText("Read just now")).toBeTruthy();
    expect(await members.findByText("teammate")).toBeTruthy();
    expect(members.queryByText("from-before")).toBeNull();
    await waitFor(() => expect(screen.queryByText(LAST_ANSWER)).toBeNull());
    await waitFor(() => expect(tauri.callsOf("team_member_states")).toHaveLength(2));
  });

  it("that read found a verdict that changed: the header says the new one, not Member of", async () => {
    let answer: (s: TeamStatus) => void = () => {};
    const notListed = { ...ownerStatus(), membership: "not_listed", membershipReason: null } as unknown as TeamStatus;
    let clone = localRead();
    const { user } = openOwnerPage({
      team_status: () => clone,
      team_refresh: () => new Promise<TeamStatus>((resolve) => (answer = resolve)),
      team_member_remove: removed,
    });
    await removeWhileReading(user);
    await waitFor(() => expect(screen.getByText(/^Member of/)).toBeTruthy());
    clone = { ...notListed, membershipStale: true };
    act(() => answer(notListed));
    await waitFor(() => expect(screen.queryByText(/^Member of/)).toBeNull());
    expect(screen.queryByText(LAST_ANSWER)).toBeNull();
  });

  it("that read went through before the write's local read landed: the same", async () => {
    let answer: (s: TeamStatus) => void = () => {};
    const held: ((s: TeamStatus) => void)[] = [];
    let holdLocal = false;
    const { user, tauri } = openOwnerPage({
      team_status: () => (holdLocal ? new Promise<TeamStatus>((resolve) => held.push(resolve)) : localRead()),
      team_refresh: () => new Promise<TeamStatus>((resolve) => (answer = resolve)),
      team_member_remove: () => {
        holdLocal = true;
        return removed;
      },
    });
    await removeWhileReading(user);
    await waitFor(() => expect(tauri.callsOf("team_status").length).toBeGreaterThan(1));
    act(() => answer(ownerStatus()));
    expect(await screen.findByText("Read just now")).toBeTruthy();
    // The read that ended asks for its own local read; it's that one that counts,
    // and the write's, landing last or first, can't undo it.
    await waitFor(() => expect(held).toHaveLength(2));
    act(() => held[0](localRead()));
    act(() => held[1](localRead()));
    await waitFor(() => expect(screen.queryByText(LAST_ANSWER)).toBeNull());
    expect(screen.getByText("Read just now")).toBeTruthy();
  });

  it("that read came back failed: still failed, with its own line, and a later write doesn't hide it", async () => {
    let answer: (s: TeamStatus) => void = () => {};
    const { user, tauri } = openOwnerPage({
      team_status: localRead,
      team_refresh: () => new Promise<TeamStatus>((resolve) => (answer = resolve)),
      team_member_remove: removed,
    });
    const members = await removeWhileReading(user);
    act(() => answer({ ...ownerStatus(), membershipStale: true, error: "Could not check access." }));
    expect(await screen.findByText("Could not check access.")).toBeTruthy();
    expect(screen.getByText(LAST_ANSWER)).toBeTruthy();
    expect(screen.queryByText("Read just now")).toBeNull();
    const before = tauri.callsOf("team_status").length;
    await user.click(await members.findByRole("button", { name: "More for joined" }));
    await user.click(await screen.findByRole("menuitem", { name: "Remove from team…" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Remove from team" }));
    await waitFor(() => expect(tauri.callsOf("team_status").length).toBeGreaterThan(before));
    expect(await screen.findByText(LAST_ANSWER)).toBeTruthy();
    expect(screen.getByText("Could not check access.")).toBeTruthy();
  });

  it("that read threw: still failed, and said", async () => {
    let refuse: (e: Error) => void = () => {};
    const { user } = openOwnerPage({
      team_status: localRead,
      team_refresh: () => new Promise<TeamStatus>((_, reject) => (refuse = reject)),
      team_member_remove: removed,
    });
    await removeWhileReading(user);
    act(() => refuse(new Error("network down")));
    await waitFor(() => expect(useToasts.getState().recent.some((t) => t.title === "Couldn't read the team")).toBe(true));
    expect(await screen.findByRole("button", { name: "Read it again" })).toBeTruthy();
    expect(screen.getByText(LAST_ANSWER)).toBeTruthy();
    expect(screen.queryByText("Read just now")).toBeNull();
  });
});
