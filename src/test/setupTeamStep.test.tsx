// OB-10 (ONBOARDING_SPEC §5 step 6, §12): Setup's "Your team" step, rendered
// inside Setup — it waits for GitHub (D14); Join from a detected team and
// from a pasted invite code, always through the sheet (the pasted repo's
// invitation accepted only by the sheet's Join, D16); the field's refusal;
// no access / SSO with their ways out; the one-team-per-Mac replacement
// sheet; Create with its sheet, then Invite people and Copy invite; the
// team's projects with their invitations and the folder asked inline; and
// the fast checklist's row.
import { afterEach, describe, expect, it } from "vitest";
import { SetupOverlay } from "../components/SetupOverlay";
import { useSetup } from "../store/setupStore";
import { useToasts } from "../store/toastStore";
import { useWorkspaces } from "../store/workspaceStore";
import { useUi } from "../store/uiStore";
import { useAccount } from "../store/accountStore";
import { useGithubStatus } from "../store/githubStatusStore";
import { useWorkMode } from "../store/workModeStore";
import { DEFAULT_SETTINGS, useSettings, type Settings } from "../store/settingsStore";
import type {
  GithubStatus,
  JoinDetection,
  JoinPreview,
  JoinProblem,
  JoinResult,
  TeamStatus,
  TeamWorkspaceView,
} from "../ipc";
import type { SetupStepId } from "../lib/settingsShape";
import { act, nextFrame, renderUi, screen, waitFor, within } from "./render";
import { setTeamWaitForTests } from "../lib/setupTeamHint";
import { tauri } from "./tauri";

afterEach(() => {
  act(() => useSetup.setState({ open: false, step: null }));
});

const git = { id: "git", found: true, versionOk: true, version: "2.39.5", installCmd: "xcode-select --install" };
const claude = { id: "claude", found: true, versionOk: true, installCmd: "curl" };
const gh = { id: "gh", found: true, versionOk: true, version: "2.101.0", installCmd: "brew install gh" };

const account = (login: string, active: boolean) => ({ login, active, state: "signed-in" as const, scopes: "repo, read:org" });
const SIGNED_IN: GithubStatus = {
  ghFound: true,
  accounts: [account("mb-member", true)],
  helper: "gh",
  githubEmail: null,
  githubNoreply: null,
  sso: null,
};
const SIGNED_OUT: GithubStatus = { ...SIGNED_IN, accounts: [] };

const TEAM = "mb-adv/ply-team";
const facts = {
  repo: TEAM,
  url: `https://github.com/${TEAM}`,
  name: "MB Adv",
  repoOwner: "mb-adv",
  repoOwnerIsOrg: false,
  manifestOwner: "mb-adv",
  private: true,
  login: "mb-member",
};

function status(over: Partial<TeamStatus> = {}): TeamStatus {
  return {
    teamRepo: null,
    teamName: null,
    ownerLogin: null,
    members: [],
    isOwner: false,
    ignoredRepos: [],
    login: "mb-member",
    membership: "unknown",
    membershipReason: null,
    membershipStale: false,
    cloneRoot: "~/Projects",
    cloneRootIsDefault: true,
    hasClone: false,
    workspaces: [],
    skills: [],
    refusedSkills: [],
    canWriteLibrary: false,
    writeLibraryReason: null,
    libraryDivergence: null,
    libraryInterruption: null,
    error: null,
    ...over,
  } as TeamStatus;
}
const joinedStatus = (over: Partial<TeamStatus> = {}) =>
  status({ teamRepo: TEAM, teamName: "MB Adv", ownerLogin: "mb-adv", membership: "member", hasClone: true, ...over });
const ws = (repo: string, over: Partial<TeamWorkspaceView> = {}): TeamWorkspaceView => ({
  repo,
  name: repo.split("/")[1],
  registered: false,
  cloned: false,
  localPath: `/Users/me/Projects/${repo.split("/")[1]}`,
  conflict: null,
  ...over,
});
const problem = (kind: JoinProblem["kind"], words: string, over: Partial<JoinProblem> = {}): JoinProblem => ({
  kind,
  words,
  org: null,
  repo: TEAM,
  accepted: false,
  details: null,
  ...over,
});
const NOTHING: JoinDetection = {
  login: "mb-member",
  teams: [],
  scanned: 12,
  truncated: false,
  unanswered: 0,
  timedOut: false,
  problem: null,
};

interface Opts {
  github?: GithubStatus;
  settings?: Partial<Settings>;
  /** null: open on the first screen (the fast checklist). */
  step?: SetupStepId | null;
  /** team_status before and after a refresh. */
  team?: () => TeamStatus;
  detect?: JoinDetection;
  preview?: (args: Record<string, unknown>) => JoinPreview;
  confirm?: (args: Record<string, unknown>) => JoinResult;
  fixtures?: Record<string, unknown>;
  /** Settings' "I have an invite code" (team walk 2026-10-01, F5). */
  teamPath?: "join";
}

async function openStep(o: Opts = {}) {
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    ...o.settings,
    onboarding: { ...DEFAULT_SETTINGS.onboarding, level: "guided", ...o.settings?.onboarding },
    team: { ...DEFAULT_SETTINGS.team, workMode: "team", ...o.settings?.team },
  };
  act(() => {
    useSettings.setState({ settings, loaded: true });
    useWorkspaces.setState({ workspaces: [], activeId: null });
  });
  const team = o.team ?? (() => status());
  const r = renderUi(<SetupOverlay />, {
    withToasts: true,
    fixtures: {
      settings_set: ({ settings: next }: Record<string, unknown>) => next,
      dependency_doctor: () => ({
        tools: [git, claude, gh],
        allRequiredOk: true,
        gitIdentity: { name: "M", email: "m@example.com", set: true, detail: "" },
        whisperModel: { model: "small", present: false, path: null, detail: "Not downloaded." },
      }),
      shell_env_info: {},
      shell_env_retry: {},
      team_work_mode: { mode: "team", chosen: true },
      team_status: () => team(),
      team_refresh: () => team(),
      project_config_list: [],
      build_cache_status: null,
      setup_check: { signedIn: true, method: "claude.ai", plan: "max", words: null },
      setup_github_status: o.github ?? SIGNED_IN,
      setup_active: null,
      setup_open_github_sso: null,
      team_join_detect: o.detect ?? NOTHING,
      team_join_preview: o.preview ?? (() => ({ kind: "problem", problem: problem("no-access", "x") })),
      team_join_confirm: o.confirm ?? (() => ({ kind: "problem", problem: problem("other", "x") })),
      team_join_workspace_invites: { accepted: [], failed: [], pending: [] },
      workspace_list: [],
      // 1.175.0 F2: the Projects folder row looks at the folder it shows.
      projects_folder_look: { path: "/Users/me/Projects", exists: true, notAFolder: false, projects: 0 },
      // 1.168.1 (C3): the inline folder write keeps the team read's root in
      // tilde form.
      "plugin:path|resolve_directory": "/Users/me",
      ...o.fixtures,
    },
  });
  act(() =>
    useSetup
      .getState()
      .openSetup("rerun", o.step === null ? undefined : (o.step ?? "team"), o.teamPath ? { teamPath: o.teamPath } : undefined),
  );
  await nextFrame();
  if (o.step === undefined || o.step === "team") await waitFor(() => expect(stepTitle()).toBe("Your team"));
  return r;
}

const stepTitle = () => document.querySelector(".ux-setup-steptitle")?.textContent;
const content = () => document.querySelector(".ux-setup-content") as HTMLElement;
const stepList = () => screen.getByRole("navigation", { name: "Setup steps" });
const toastTitles = () => useToasts.getState().toasts.map((t) => t.title);

async function chooseJoin(user: ReturnType<typeof renderUi>["user"]) {
  await user.click(screen.getByRole("radio", { name: /Join a team/ }));
}

// ── Opened from Settings with an invite code (team walk 2026-10-01, F5) ──

describe("Setup step 6 opened by Settings' I have an invite code", () => {
  it("opens on Join with the invite-code field, once", async () => {
    await openStep({ teamPath: "join" });
    const join = screen.getByRole("radio", { name: /Join a team/ }) as HTMLInputElement;
    await waitFor(() => expect(join.checked || join.getAttribute("aria-checked") === "true").toBe(true));
    expect(await screen.findByRole("textbox", { name: "Invite code" })).toBeTruthy();
    expect(useSetup.getState().teamPath).toBeNull();
  });

  it("is forgotten when Setup closes before the Team step takes it", () => {
    act(() => useSetup.getState().openSetup("rerun", "git", { teamPath: "join" }));
    expect(useSetup.getState().teamPath).toBe("join");
    act(() => useSetup.getState().closeSetup());
    expect(useSetup.getState().teamPath).toBeNull();
  });
});

// ── D14 ──────────────────────────────────────────────────────────────────

describe("Setup step 6 waits for GitHub (D14)", () => {
  it("without a GitHub account: only Connect GitHub first, Go to GitHub, and Continue moves on", async () => {
    const { user } = await openStep({ github: SIGNED_OUT });
    await waitFor(() => expect(content().textContent).toContain("Connect GitHub first."));
    expect(screen.getByRole("dialog", { name: "Setup" }).textContent).toContain(
      "A Plyloft team is a private GitHub repository that lists who is in it, which projects you share, and a library your agents can use. Team features run on the Team plan.",
    );
    expect(screen.queryByRole("radio", { name: /Join a team/ })).toBeNull();
    expect(tauri().callsOf("team_join_detect")).toHaveLength(0);
    await user.click(within(content()).getByRole("button", { name: "Go to GitHub" }));
    await waitFor(() => expect(stepTitle()).toBe("Connect GitHub for your projects"));
  });

  it("the fast checklist's Team row says Connect GitHub first and goes there", async () => {
    const { user } = await openStep({
      github: SIGNED_OUT,
      step: null,
      settings: { onboarding: { ...DEFAULT_SETTINGS.onboarding, level: "fast" } },
    });
    const row = await screen.findByRole("button", { name: "Connect GitHub first" });
    await user.click(row);
    await waitFor(() => expect(stepTitle()).toBe("Connect GitHub for your projects"));
  });
});

// ── Join ─────────────────────────────────────────────────────────────────

describe("Setup step 6, Join", () => {
  it("U5: the team's owner reads Your team, with no invited-by", async () => {
    const { user } = await openStep({
      detect: { ...NOTHING, login: "mb-adv", teams: [{ repo: TEAM, name: "MB Adv", owner: "mb-adv", current: false }] },
    });
    await chooseJoin(user);
    expect(await screen.findByText("Your team “MB Adv”")).toBeTruthy();
    expect(screen.getByText("mb-adv/ply-team, on GitHub.")).toBeTruthy();
    expect(screen.queryByText(/been invited|invited you to/)).toBeNull();
  });

  it("a detected team: its row, then the sheet, and only Join joins", async () => {
    let joined = false;
    const { user } = await openStep({
      team: () => (joined ? joinedStatus() : status()),
      detect: { ...NOTHING, teams: [{ repo: TEAM, name: "MB Adv", owner: "test-owner", current: false }] },
      preview: () => ({
        kind: "ready",
        team: facts,
        workspaceInvites: [{ id: 7, repo: "mb-adv/app", inviter: "mb-adv" }],
        replaces: null,
        alreadyIn: false,
        calls: [`gh api repos/${TEAM}/contents/team.json`],
      }),
      confirm: () => {
        joined = true;
        return {
          kind: "joined",
          repo: TEAM,
          name: "MB Adv",
          acceptedInvitation: false,
          workspaces: { accepted: ["mb-adv/app"], failed: [], pending: [] },
          replaced: null,
        };
      },
    });
    await chooseJoin(user);
    expect(await screen.findByText("“MB Adv” lists you as a member")).toBeTruthy();
    expect(screen.queryByText(/been invited|invited you to/)).toBeNull();
    expect(screen.getByText("mb-adv/ply-team, by test-owner, on GitHub.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Join MB Adv" }));
    expect(tauri().callsOf("team_join_preview")[0].args).toEqual({ code: TEAM, account: null });

    const sheet = await screen.findByRole("dialog", { name: "Join the team at mb-adv/ply-team?" });
    expect(sheet.textContent).toContain("The team is the private repository mb-adv/ply-team on GitHub, owned by mb-adv.");
    expect(sheet.textContent).toContain("It calls itself “MB Adv”.");
    expect(sheet.textContent).not.toContain("team.json names");
    expect(sheet.textContent).toContain("Joining lets your agents use the team's skills and notes");
    expect(sheet.textContent).toContain("Plyloft will accept your GitHub invitation to mb-adv/app.");
    expect(tauri().callsOf("team_join_confirm")).toHaveLength(0);
    await user.click(within(sheet).getByRole("button", { name: "Join" }));

    await waitFor(() => expect(tauri().callsOf("team_join_confirm")).toHaveLength(1));
    expect(tauri().callsOf("team_join_confirm")[0].args).toEqual({
      request: { repo: TEAM, acceptInvitation: null, acceptWorkspaces: ["mb-adv/app"], replace: false },
      account: null,
    });
    await waitFor(() => expect(toastTitles()).toContain("You're in “MB Adv”."));
    await waitFor(() => expect(content().textContent).toContain("You're in “MB Adv”."));
    await waitFor(() =>
      expect(within(stepList()).getByRole("button", { name: /Your team/ }).textContent).toContain("Done"),
    );
  });

  it("a team.json that claims another owner: the title is the repository, the owner GitHub's, the claims said as claims (detected and pasted)", async () => {
    const hostile = {
      ...facts,
      repo: "evil/ply-team",
      url: "https://github.com/evil/ply-team",
      repoOwner: "evil",
      manifestOwner: "mb-adv",
    };
    const { user } = await openStep({
      detect: { ...NOTHING, teams: [{ repo: "evil/ply-team", name: "MB Adv", owner: "mb-adv", current: false }] },
      preview: () => ({ kind: "ready", team: hostile, workspaceInvites: [], replaces: null, alreadyIn: false, calls: [] }),
    });
    await chooseJoin(user);
    // Detected: the row names where it really is.
    expect(await screen.findByText("evil/ply-team, by mb-adv, on GitHub.")).toBeTruthy();
    for (const open of [
      () => user.click(screen.getByRole("button", { name: "Join MB Adv" })),
      () => user.type(screen.getByLabelText("Invite code"), "ply-join:evil/ply-team{Enter}"),
    ]) {
      await open();
      const sheet = await screen.findByRole("dialog", { name: "Join the team at evil/ply-team?" });
      expect(sheet.textContent).toContain("The team is the private repository evil/ply-team on GitHub, owned by evil.");
      expect(sheet.textContent).toContain("It calls itself “MB Adv”.");
      expect(sheet.textContent).toContain("team.json names mb-adv as the team's owner.");
      expect(sheet.textContent).not.toContain("owned by mb-adv");
      await user.click(within(sheet).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("dialog", { name: /Join the team/ })).toBeNull());
    }
    expect(tauri().callsOf("team_join_confirm")).toHaveLength(0);
  });

  it("Look again asks GitHub afresh; a look stopped by its deadline says so", async () => {
    const { user } = await openStep({ detect: { ...NOTHING, scanned: 100, unanswered: 40, timedOut: true } });
    await chooseJoin(user);
    expect(
      await screen.findByText(
        "Plyloft stopped looking after 30 seconds: 40 of 100 repositories weren't checked. Look again, or paste your invite code.",
      ),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Look again" }));
    await waitFor(() => expect(tauri().callsOf("team_join_detect").slice(-1)[0].args).toEqual({ account: null, refresh: true }));
  });

  it("a pasted code with a pending invitation: the sheet says it will accept it and who invited; Join sends that id", async () => {
    const { user } = await openStep({
      preview: () => ({
        kind: "invited",
        team: { ...facts, name: null, manifestOwner: null, private: null },
        invitation: { id: 12, inviter: "mb-friend", inviterNotOwner: true },
        replaces: null,
        calls: [],
      }),
      confirm: () => ({ kind: "problem", problem: problem("not-a-team", "mb-adv/ply-team isn't a Plyloft team. It has no team.json. You accepted GitHub's invitation to it; nothing else was changed.", { accepted: true }) }),
    });
    await chooseJoin(user);
    await waitFor(() => expect(content().textContent).toContain("No team found that lists you yet."));
    await user.type(screen.getByLabelText("Invite code"), "ply-join:mb-adv/ply-team{Enter}");
    expect(tauri().callsOf("team_join_preview")[0].args).toEqual({ code: "ply-join:mb-adv/ply-team", account: null });
    const sheet = await screen.findByRole("dialog", { name: "Join the team at mb-adv/ply-team?" });
    expect(sheet.textContent).toContain("Plyloft will accept your GitHub invitation to mb-adv/ply-team.");
    expect(sheet.textContent).toContain("Invited by mb-friend, not the team's owner.");
    await user.click(within(sheet).getByRole("button", { name: "Join" }));
    await waitFor(() =>
      expect(tauri().callsOf("team_join_confirm")[0].args).toEqual({
        request: { repo: TEAM, acceptInvitation: 12, acceptWorkspaces: [], replace: false },
        account: null,
      }),
    );
    // Not a team after all: said, with what was accepted.
    expect(await screen.findByText("That repository isn't a Plyloft team.")).toBeTruthy();
    expect(content().textContent).toContain("Only GitHub's invitation was accepted. Plyloft didn't join the team");
  });

  it("a code the field refuses is said under it, and no sheet opens", async () => {
    const { user } = await openStep({
      preview: () => ({ kind: "problem", problem: problem("not-a-code", "That isn't a Plyloft invite code.") }),
    });
    await chooseJoin(user);
    await user.type(screen.getByLabelText("Invite code"), "ply-join:mb-аdv/team{Enter}");
    expect(await screen.findByText("That isn't a Plyloft invite code.")).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: /Join/ })).toBeNull();
    expect(tauri().callsOf("team_join_confirm")).toHaveLength(0);
  });

  it("no access: the owner's ask in words and Look again asks GitHub again", async () => {
    const { user } = await openStep({
      preview: () => ({
        kind: "problem",
        problem: problem("no-access", "You don't have access to mb-adv/ply-team yet. Ask the owner to invite your GitHub account “mb-member”."),
      }),
    });
    await chooseJoin(user);
    await user.type(screen.getByLabelText("Invite code"), "mb-adv/ply-team");
    await user.click(within(content()).getByRole("button", { name: "Look it up" }));
    expect(
      await screen.findByText("You don't have access to mb-adv/ply-team yet. Ask the owner to invite your GitHub account “mb-member”."),
    ).toBeTruthy();
    // The code stays pasted.
    expect((screen.getByLabelText("Invite code") as HTMLInputElement).value).toBe("mb-adv/ply-team");
    // 1.175.0 F9 (I12): the problem's own Look again (the detection's is
    // named the same, one label for the press everywhere).
    const problemBlock = screen
      .getByText("You don't have access to mb-adv/ply-team yet. Ask the owner to invite your GitHub account “mb-member”.")
      .closest(".ux-error") as HTMLElement;
    await user.click(within(problemBlock).getByRole("button", { name: "Look again" }));
    await waitFor(() => expect(tauri().callsOf("team_join_preview")).toHaveLength(2));
  });

  it("single sign-on: Authorize opens the organization's page", async () => {
    const { user } = await openStep({
      preview: () => ({
        kind: "problem",
        problem: problem("sso", "Your organization “acme” needs you to authorize the GitHub command for single sign-on.", { org: "acme" }),
      }),
    });
    await chooseJoin(user);
    await user.type(screen.getByLabelText("Invite code"), "acme/ply-team{Enter}");
    await user.click(await screen.findByRole("button", { name: "Authorize" }));
    expect(tauri().callsOf("setup_open_github_sso")[0].args).toEqual({ org: "acme" });
  });

  it("already in another team: the replacement sheet names what is kept, and only then joins with replace", async () => {
    const { user } = await openStep({
      preview: () => ({
        kind: "ready",
        team: facts,
        workspaceInvites: [],
        replaces: { repo: "other/team", name: "Other team" },
        alreadyIn: false,
        calls: [],
      }),
      confirm: () => ({
        kind: "joined",
        repo: TEAM,
        name: "MB Adv",
        acceptedInvitation: false,
        workspaces: { accepted: [], failed: [], pending: [] },
        replaced: "other/team",
      }),
    });
    await chooseJoin(user);
    await user.type(screen.getByLabelText("Invite code"), "ply-join:mb-adv/ply-team{Enter}");
    await user.click(within(await screen.findByRole("dialog", { name: "Join the team at mb-adv/ply-team?" })).getByRole("button", { name: "Join" }));
    const replace = await screen.findByRole("dialog", { name: "Replace “Other team”?" });
    expect(replace.textContent).toContain("This Mac is in “Other team”. Joining mb-adv/ply-team replaces it.");
    expect(replace.textContent).toContain("Your projects from “Other team”, their folders and everything on GitHub stay as they are.");
    expect(tauri().callsOf("team_join_confirm")).toHaveLength(0);
    await user.click(within(replace).getByRole("button", { name: "Join mb-adv/ply-team" }));
    await waitFor(() => expect(tauri().callsOf("team_join_confirm")[0].args).toMatchObject({ request: { replace: true } }));
  });

  it("several accounts: the choice is sent with every call", async () => {
    const { user } = await openStep({
      github: { ...SIGNED_IN, accounts: [account("mb-member", true), account("mb-work", false)] },
    });
    await chooseJoin(user);
    await waitFor(() => expect(tauri().callsOf("team_join_detect")[0]?.args).toEqual({ account: "mb-member", refresh: false }));
    await user.selectOptions(screen.getByRole("combobox", { name: "GitHub account" }), "mb-work");
    await waitFor(() => expect(tauri().callsOf("team_join_detect").slice(-1)[0]?.args).toEqual({ account: "mb-work", refresh: false }));
    await user.type(screen.getByLabelText("Invite code"), "mb-adv/ply-team{Enter}");
    await waitFor(() => expect(tauri().callsOf("team_join_preview")[0].args).toEqual({ code: "mb-adv/ply-team", account: "mb-work" }));
  });
});

// ── Create ───────────────────────────────────────────────────────────────

describe("Setup step 6, Create", () => {
  it("name → suggested repository → sheet → created; then Invite people and Copy invite", async () => {
    let created = false;
    const { user } = await openStep({
      team: () => (created ? joinedStatus({ isOwner: true, members: [{ login: "test-owner", owner: true }] }) : status()),
      fixtures: {
        // Launch T1: a Team owner with no repository yet (paid, or comp).
        team_billing_get: { stage: { stage: "create", comp: true }, team: null, error: null },
        team_create_defaults: { login: "test-owner", workspaces: [] },
        team_create: ({ name, repo }: Record<string, unknown>) => {
          created = true;
          return { name, repo, clonePath: "/x", alreadyExisted: false };
        },
        team_invite_code: {
          code: "ply-join:test-owner/mb-adv-team",
          message: "Join “MB Adv” in Plyloft.\n…ply-join:test-owner/mb-adv-team\n",
        },
      },
    });
    await user.click(screen.getByRole("radio", { name: /Create a team/ }));
    await user.type(screen.getByLabelText("Team name"), "MB Adv");
    await waitFor(() => expect((screen.getByLabelText("Repository") as HTMLInputElement).value).toBe("test-owner/mb-adv-team"));
    await user.click(within(content()).getByRole("button", { name: "Create team" }));
    const sheet = await screen.findByRole("dialog", { name: "Create the team “MB Adv”?" });
    expect(sheet.textContent).toContain(
      "Plyloft will create the private repository test-owner/mb-adv-team on GitHub, with the team's member list and an empty library. You'll be its owner.",
    );
    expect(tauri().callsOf("team_create")).toHaveLength(0);
    await user.click(within(sheet).getByRole("button", { name: "Create team" }));
    await waitFor(() =>
      expect(tauri().callsOf("team_create")[0].args).toEqual({ name: "MB Adv", repo: "test-owner/mb-adv-team", workspaces: [] }),
    );
    await waitFor(() => expect(content().textContent).toContain("You're in “MB Adv”."));
    expect(screen.getByText("Invite people")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Copy invite" }));
    await waitFor(() => expect(toastTitles()).toContain("Invite copied"));
    expect(await navigator.clipboard.readText()).toContain("ply-join:test-owner/mb-adv-team");
    // Team walk 2026-10-01 (F2): the code that was copied is on screen too.
    expect(screen.getByText("ply-join:test-owner/mb-adv-team")).toBeTruthy();
  });

  it("U4/U20: a member has no Copy invite; the step says who to ask", async () => {
    await openStep({ team: () => joinedStatus({ isOwner: false, ownerLogin: "mb-adv" }) });
    await waitFor(() => expect(content().textContent).toContain("You're in “MB Adv”."));
    expect(screen.queryByRole("button", { name: "Copy invite" })).toBeNull();
    expect(screen.queryByText("Invite people")).toBeNull();
    expect(content().textContent).toContain("Ask mb-adv to invite people.");
  });

  it("a name that exists on GitHub: the refusal is shown, nothing else", async () => {
    const { user } = await openStep({
      fixtures: {
        // Launch T1: a Team owner with no repository yet (paid, or comp).
        team_billing_get: { stage: { stage: "create", comp: true }, team: null, error: null },
        team_create_defaults: { login: "me", workspaces: [] },
        team_create: () => {
          throw "me/x-team already exists on GitHub and isn't an unfinished team Plyloft started.";
        },
      },
    });
    await user.click(screen.getByRole("radio", { name: /Create a team/ }));
    await user.type(screen.getByLabelText("Team name"), "X");
    await user.click(within(content()).getByRole("button", { name: "Create team" }));
    await user.click(within(await screen.findByRole("dialog", { name: "Create the team “X”?" })).getByRole("button", { name: "Create team" }));
    expect(await screen.findByText("The team wasn't created.")).toBeTruthy();
    expect(content().textContent).toContain("already exists on GitHub");
  });
});

// ── Joined ───────────────────────────────────────────────────────────────

describe("Setup step 6, joined", () => {
  it("detected done: You're in, and the half-state the probe explains", async () => {
    await openStep({
      github: SIGNED_OUT,
      settings: { team: { ...DEFAULT_SETTINGS.team, workMode: "team", teamRepo: TEAM } },
      team: () => joinedStatus({ membership: "no_repo_access" }),
    });
    await waitFor(() => expect(content().textContent).toContain("You're in “MB Adv”."));
    expect(content().textContent).toContain(
      "The owner listed you, but GitHub hasn't given you access yet. Ask them to check your invitation.",
    );
    // Done wins over the wait for GitHub.
    expect(content().textContent).not.toContain("Connect GitHub first.");
  });

  it("a team joined with a non-active account: its projects' invitations are read and accepted as that account", async () => {
    const { user } = await openStep({
      github: { ...SIGNED_IN, accounts: [account("mb-member", true), account("mb-work", false)] },
      settings: {
        team: { ...DEFAULT_SETTINGS.team, workMode: "team", teamRepo: TEAM, account: "mb-work" },
        projects: { ...DEFAULT_SETTINGS.projects, folder: "~/Projects" },
      },
      team: () => joinedStatus({ workspaces: [ws("mb-adv/app")] }),
      fixtures: {
        team_join_workspace_invites: { accepted: [], failed: [], pending: [{ id: 7, repo: "mb-adv/app", inviter: "mb-adv" }] },
        team_join_accept_workspaces: { accepted: ["mb-adv/app"], failed: [], pending: [] },
        team_workspace_add: { repo: "mb-adv/app", path: "/p/app", name: "app", cloned: true, registered: true, membershipFromCache: false },
        team_invite_code: { code: "ply-join:mb-adv/ply-team", message: "m" },
      },
    });
    await waitFor(() => expect(tauri().callsOf("team_join_workspace_invites")[0]?.args).toEqual({ account: "mb-work" }));
    await user.click(await screen.findByRole("button", { name: "Get 1 project" }));
    await user.click(within(await screen.findByRole("dialog", { name: "Accept the invitation?" })).getByRole("button", { name: "Accept and get it" }));
    await waitFor(() =>
      expect(tauri().callsOf("team_join_accept_workspaces")[0]?.args).toEqual({ repos: ["mb-adv/app"], account: "mb-work" }),
    );
  });

  // 1.175.0 F2 (UX-3, I4): solo or team is deduced and saved without
  // asking (mockup §2a); the question comes only from the link.
  describe("F2: solo or team, deduced", () => {
    const solo = { team: { ...DEFAULT_SETTINGS.team, workMode: null } };
    const soloFixtures = { team_work_mode: { mode: "solo", chosen: false } };
    const savedModes = () =>
      tauri()
        .callsOf("settings_set")
        .map((c) => (c.args.settings as Settings).team?.workMode);
    const titles = () => within(stepList()).getAllByRole("button").map((b) => b.querySelector(".ux-step-title")?.textContent);
    afterEach(() => act(() => useAccount.setState({ info: null, loaded: false })));

    it("a Team plan: team without asking, Your team in the list, GitHub not asked", async () => {
      act(() => useWorkMode.setState({ mode: "solo", chosen: false }));
      act(() => useAccount.setState({ info: { signedIn: true, login: "ana", plan: "team", teamRole: "member" } as never, loaded: true }));
      await openStep({ step: "ai", settings: solo, fixtures: soloFixtures });
      // The AI step's own reads don't matter here.
      tauri().allowUnhandled();
      await waitFor(() => expect(savedModes()).toContain("team"));
      expect(savedModes()).not.toContain("solo");
      expect(titles()).toContain("Your team");
      expect(titles()).not.toContain("Solo or team");
      expect(screen.queryByRole("button", { name: "Add the team step" })).toBeNull();
      expect(tauri().callsOf("setup_team_hint")).toHaveLength(0);
    });

    it("a Plyloft team lists this GitHub account: team, read once GitHub is connected", async () => {
      act(() => useWorkMode.setState({ mode: "solo", chosen: false }));
      await openStep({
        step: "ai",
        settings: solo,
        fixtures: { ...soloFixtures, setup_team_hint: { read: true, login: "mb-member", teams: ["mb-adv/ply-team"], invitations: 0, problem: null } },
      });
      // The AI step's own reads don't matter here.
      tauri().allowUnhandled();
      await waitFor(() => expect(savedModes()).toContain("team"));
      expect(tauri().callsOf("setup_team_hint")).toHaveLength(1);
      await waitFor(() => expect(titles()).toContain("Your team"));
      // Immediacy walk (run 1, note 3): Ready says what the deduction found,
      // not "Not in a team yet." beside the team step it put in the list.
      const ready = within(stepList())
        .getAllByRole("button")
        .find((b) => b.querySelector(".ux-step-title")?.textContent === "Ready")!;
      await act(async () => ready.click());
      const team = await screen.findByText("Teams that list you: mb-adv/ply-team.");
      expect(team).toBeTruthy();
      expect(screen.queryByText("Not in a team yet.")).toBeNull();
    });

    // F2 round 2 (review): an invitation to a team's repository shows the
    // team step and its Join; team is saved only when the person joins.
    it("an invitation to a team's repository: Your team in the list, nothing saved", async () => {
      act(() => useWorkMode.setState({ mode: "solo", chosen: false }));
      await openStep({
        step: "ai",
        settings: solo,
        fixtures: { ...soloFixtures, setup_team_hint: { read: true, login: "mb-member", teams: [], invitations: 1, problem: null } },
      });
      // The AI step's own reads don't matter here.
      tauri().allowUnhandled();
      await waitFor(() => expect(titles()).toContain("Your team"));
      await nextFrame();
      expect(savedModes()).not.toContain("team");
      expect(savedModes()).not.toContain("solo");
    });

    it("nothing found, or GitHub can't be read: solo without asking, and the link stays", async () => {
      act(() => useWorkMode.setState({ mode: "solo", chosen: false }));
      await openStep({
        step: "ai",
        settings: solo,
        fixtures: {
          ...soloFixtures,
          setup_team_hint: () => {
            throw new Error("offline");
          },
        },
      });
      // The AI step's own reads don't matter here.
      tauri().allowUnhandled();
      await waitFor(() => expect(tauri().callsOf("setup_team_hint")).toHaveLength(1));
      await nextFrame();
      // F2 round 2 (review): solo is never saved by the deduction — a later
      // team, joined or bought, still makes the mode team.
      expect(savedModes()).not.toContain("solo");
      expect(savedModes()).not.toContain("team");
      expect(titles()).not.toContain("Your team");
      expect(screen.getByRole("button", { name: "Add the team step" })).toBeTruthy();
    });

    // 1.176.4: Continue on Your AI waits for GitHub's answer about teams.
    describe("Continue on Your AI waits for the teams answer", () => {
      const WAIT = "Looking for your teams…";
      afterEach(() => setTeamWaitForTests(null));
      const deferred = () => {
        let resolve!: (v: unknown) => void;
        const promise = new Promise((r) => (resolve = r));
        return { promise, resolve };
      };

      it("a quick Continue waits, then goes on to Your team when the answer lists one", async () => {
        act(() => useWorkMode.setState({ mode: "solo", chosen: false }));
        const hint = deferred();
        const { user } = await openStep({
          step: "ai",
          settings: solo,
          fixtures: { ...soloFixtures, setup_team_hint: () => hint.promise },
        });
        tauri().allowUnhandled();
        await waitFor(() => expect(tauri().callsOf("setup_team_hint")).toHaveLength(1));
        await waitFor(() => expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(false));
        await user.click(screen.getByRole("button", { name: "Continue" }));
        expect(screen.getByText(WAIT)).toBeTruthy();
        expect(stepTitle()).toBe("Your AI");
        await act(async () => hint.resolve({ read: true, login: "mb-member", teams: ["mb-adv/ply-team"], invitations: 0, problem: null }));
        await waitFor(() => expect(stepTitle()).toBe("Your team"));
        expect(screen.queryByText(WAIT)).toBeNull();
      });

      it("an answer that never comes: it goes on without the team after the time limit", async () => {
        act(() => useWorkMode.setState({ mode: "solo", chosen: false }));
        setTeamWaitForTests(50);
        const { user } = await openStep({
          step: "ai",
          settings: solo,
          fixtures: { ...soloFixtures, setup_team_hint: () => new Promise(() => {}) },
        });
        tauri().allowUnhandled();
        await waitFor(() => expect(tauri().callsOf("setup_team_hint")).toHaveLength(1));
        await waitFor(() => expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(false));
        await user.click(screen.getByRole("button", { name: "Continue" }));
        expect(screen.getByText(WAIT)).toBeTruthy();
        await waitFor(() => expect(stepTitle()).not.toBe("Your AI"));
        expect(stepTitle()).not.toBe("Your team");
        expect(screen.queryByText(WAIT)).toBeNull();
      });

      const pending = async (extra: Record<string, unknown> = {}) => {
        act(() => useWorkMode.setState({ mode: "solo", chosen: false }));
        const hint = deferred();
        const r = await openStep({
          step: "ai",
          settings: solo,
          fixtures: { ...soloFixtures, setup_team_hint: () => hint.promise, ...extra },
        });
        tauri().allowUnhandled();
        await waitFor(() => expect(tauri().callsOf("setup_team_hint")).toHaveLength(1));
        await nextFrame();
        return { ...r, hint };
      };
      const teams = { read: true, login: "mb-member", teams: ["mb-adv/ply-team"], invitations: 0, problem: null };

      it("Skip for now waits the same way, and is off during the wait", async () => {
        // Signed out: the step isn't done, so it can be skipped.
        const { user, hint } = await pending({ setup_check: { signedIn: false, method: "none", plan: null, words: null } });
        await user.click(screen.getByRole("button", { name: "Skip for now" }));
        expect(screen.getByText(WAIT)).toBeTruthy();
        expect(stepTitle()).toBe("Your AI");
        expect((screen.getByRole("button", { name: "Skip for now" }) as HTMLButtonElement).disabled).toBe(true);
        await act(async () => hint.resolve(teams));
        await waitFor(() => expect(stepTitle()).toBe("Your team"));
      });

      it("Back during the wait goes back, drops the line, and the answer then moves nothing", async () => {
        const { user, hint } = await pending();
        await user.click(screen.getByRole("button", { name: "Continue" }));
        expect(screen.getByText(WAIT)).toBeTruthy();
        await user.click(screen.getByRole("button", { name: "Back" }));
        expect(stepTitle()).not.toBe("Your AI");
        const here = stepTitle();
        expect(screen.queryByText(WAIT)).toBeNull();
        await act(async () => hint.resolve(teams));
        await nextFrame();
        expect(stepTitle()).toBe(here);
      });

      it("closing Setup during the wait leaves nothing running", async () => {
        setTeamWaitForTests(50);
        const { user, hint } = await pending();
        await user.click(screen.getByRole("button", { name: "Continue" }));
        await user.click(screen.getByRole("button", { name: "Close setup" }));
        await waitFor(() => expect(useSetup.getState().open).toBe(false));
        await act(async () => hint.resolve(teams));
        await new Promise((r) => setTimeout(r, 120));
        expect(useSetup.getState().open).toBe(false);
      });

      it("an answer with only an invitation goes on to Your team too", async () => {
        const { user, hint } = await pending();
        await user.click(screen.getByRole("button", { name: "Continue" }));
        await act(async () => hint.resolve({ read: true, login: "mb-member", teams: [], invitations: 1, problem: null }));
        await waitFor(() => expect(stepTitle()).toBe("Your team"));
        expect(savedModes()).not.toContain("team");
      });

      it("GitHub's status not read yet, with the command there, counts as pending, under the same limit", async () => {
        act(() => useWorkMode.setState({ mode: "solo", chosen: false }));
        setTeamWaitForTests(80);
        act(() => useGithubStatus.setState({ status: null }));
        const { user } = await openStep({
          step: "ai",
          settings: solo,
          fixtures: { ...soloFixtures, setup_github_status: () => new Promise(() => {}), setup_team_hint: () => new Promise(() => {}) },
        });
        tauri().allowUnhandled();
        await waitFor(() => expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(false));
        await user.click(screen.getByRole("button", { name: "Continue" }));
        expect(screen.getByText(WAIT)).toBeTruthy();
        await waitFor(() => expect(stepTitle()).not.toBe("Your AI"));
        expect(screen.queryByText(WAIT)).toBeNull();
      });

      it("the answer already there: no waiting at all", async () => {
        act(() => useWorkMode.setState({ mode: "solo", chosen: false }));
        const { user } = await openStep({
          step: "ai",
          settings: solo,
          fixtures: { ...soloFixtures, setup_team_hint: { read: true, login: "mb-member", teams: ["mb-adv/ply-team"], invitations: 0, problem: null } },
        });
        tauri().allowUnhandled();
        await waitFor(() => expect(titles()).toContain("Your team"));
        await waitFor(() => expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(false));
        await user.click(screen.getByRole("button", { name: "Continue" }));
        expect(screen.queryByText(WAIT)).toBeNull();
        await waitFor(() => expect(stepTitle()).toBe("Your team"));
      });

      it("nobody signed in to GitHub: no waiting", async () => {
        act(() => useWorkMode.setState({ mode: "solo", chosen: false }));
        const { user } = await openStep({
          step: "ai",
          settings: solo,
          github: { ...SIGNED_IN, accounts: [] },
          fixtures: { ...soloFixtures, setup_team_hint: () => new Promise(() => {}) },
        });
        tauri().allowUnhandled();
        await nextFrame();
        await waitFor(() => expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(false));
        await user.click(screen.getByRole("button", { name: "Continue" }));
        expect(screen.queryByText(WAIT)).toBeNull();
        expect(tauri().callsOf("setup_team_hint")).toHaveLength(0);
      });
    });

    it("a choice already made stays: nothing read, nothing saved", async () => {
      act(() => useWorkMode.setState({ mode: "solo", chosen: true }));
      await openStep({ step: "ai", settings: { team: { ...DEFAULT_SETTINGS.team, workMode: "solo" } }, fixtures: soloFixtures });
      // The AI step's own reads don't matter here.
      tauri().allowUnhandled();
      await nextFrame();
      expect(tauri().callsOf("setup_team_hint")).toHaveLength(0);
      expect(savedModes().filter((m) => m !== "solo")).toEqual([]);
      expect(screen.getByRole("button", { name: "Add the team step" })).toBeTruthy();
    });

    it("an invited member nobody lists yet: the link, With a team, then the invite-code field", async () => {
      act(() => useWorkMode.setState({ mode: "solo", chosen: false }));
      const { user } = await openStep({
        step: "ai",
        settings: solo,
        fixtures: { ...soloFixtures, setup_team_hint: { read: true, login: "mb-member", teams: [], invitations: 0, problem: null } },
      });
      // The AI step's own reads don't matter here.
      tauri().allowUnhandled();
      await waitFor(() => expect(tauri().callsOf("setup_team_hint")).toHaveLength(1));
      await user.click(screen.getByRole("button", { name: "Add the team step" }));
      await waitFor(() => expect(stepTitle()).toBe("Do you work alone or with a team?"));
      expect(content().textContent).not.toContain("Plyloft found a team");
      expect(screen.getByRole("dialog").textContent).toContain("Plyloft found no team for mb-member, so it set you up on your own.");
      await user.click(screen.getByRole("radio", { name: /With a team/ }));
      expect(titles().indexOf("Your team")).toBe(titles().indexOf("Git and your name") + 1);
      act(() => useWorkMode.setState({ mode: "team", chosen: true }));
      await user.click(screen.getByRole("button", { name: "Continue" }));
      await waitFor(() => expect(savedModes()[savedModes().length - 1]).toBe("team"));
      await user.click(within(stepList()).getByRole("button", { name: /Your team/ }));
      await waitFor(() => expect(stepTitle()).toBe("Your team"));
    });
  });

  it("U27: a member with a clone sees the offline read at once, with no network read", async () => {
    await openStep({
      settings: { team: { ...DEFAULT_SETTINGS.team, workMode: "team", teamRepo: TEAM } },
      team: () => joinedStatus({ workspaces: [ws("mb-adv/app")] }),
      fixtures: {
        team_refresh: () => {
          throw new Error("offline");
        },
        team_join_workspace_invites: { accepted: [], failed: [], pending: [] },
      },
    });
    await waitFor(() => expect(content().textContent).toContain("The team's projects"));
    expect(content().textContent).toContain("You're in “MB Adv”.");
    expect(tauri().callsOf("team_refresh")).toHaveLength(0);
    expect(content().textContent).not.toContain("hasn't read");
  });

  it("U27: an offline read landing after the join's network read doesn't lose the team's projects", async () => {
    let answerOffline: (s: TeamStatus) => void = () => {};
    const late = new Promise<TeamStatus>((resolve) => (answerOffline = resolve));
    const { user } = await openStep({
      team: () => late as never,
      detect: { ...NOTHING, teams: [{ repo: TEAM, name: "MB Adv", owner: "mb-adv", current: false }] },
      preview: () => ({ kind: "ready", team: facts, workspaceInvites: [], replaces: null, alreadyIn: false, calls: [] }),
      confirm: () => ({
        kind: "joined",
        repo: TEAM,
        name: "MB Adv",
        acceptedInvitation: false,
        workspaces: { accepted: [], failed: [], pending: [] },
        replaced: null,
      }),
      fixtures: {
        team_refresh: () => joinedStatus({ workspaces: [ws("mb-adv/app")] }),
        team_join_workspace_invites: { accepted: [], failed: [], pending: [] },
      },
    });
    await chooseJoin(user);
    await user.click(await screen.findByRole("button", { name: "Join MB Adv" }));
    const sheet = await screen.findByRole("dialog", { name: "Join the team at mb-adv/ply-team?" });
    await user.click(within(sheet).getByRole("button", { name: "Join" }));
    await waitFor(() => expect(content().textContent).toContain("The team's projects"));
    // The read from before the join lands now, and says nothing of the team.
    await act(async () => answerOffline(status()));
    expect(content().textContent).toContain("You're in “MB Adv”.");
    expect(content().textContent).toContain("The team's projects");
  });

  it("U27: a team repository that couldn't be read says why and offers the read again", async () => {
    let reads = 0;
    const { user } = await openStep({
      settings: { team: { ...DEFAULT_SETTINGS.team, workMode: "team", teamRepo: TEAM } },
      team: () => status({ teamRepo: TEAM }),
      fixtures: {
        team_refresh: () => {
          reads += 1;
          return reads === 1
            ? status({ teamRepo: TEAM, error: "Could not fetch the team repo: offline" } as Partial<TeamStatus>)
            : joinedStatus({ isOwner: true, workspaces: [ws("mb-adv/app")] });
        },
        team_join_workspace_invites: { accepted: [], failed: [], pending: [] },
        team_invite_code: { code: "ply-join:mb-adv/ply-team", message: "m" },
      },
    });
    expect(await screen.findByText("Could not fetch the team repo: offline")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Read it again" }));
    await waitFor(() => expect(content().textContent).toContain("The team's projects"));
    expect(screen.queryByRole("button", { name: "Read it again" })).toBeNull();
  });

  it("U31: a project whose folder is gone can be got again, and opens", async () => {
    tauri().allowUnhandled();
    const gone = ws("mb-adv/app", { registered: true, cloned: false });
    const lyra = { id: "w-app", name: "app", cwd: "/p/app", createdAt: 1, lastOpenedAt: 1, openFiles: [], activeFile: null };
    const { user } = await openStep({
      settings: { team: { ...DEFAULT_SETTINGS.team, workMode: "team", teamRepo: TEAM }, projects: { ...DEFAULT_SETTINGS.projects, folder: "~/Projects" } },
      team: () => joinedStatus({ workspaces: [gone] }),
      fixtures: {
        team_join_workspace_invites: { accepted: [], failed: [], pending: [] },
        team_workspace_add: { repo: "mb-adv/app", path: "/p/app", name: "app", cloned: true, registered: false, membershipFromCache: false },
        workspace_list: { workspaces: [lyra], activeId: null },
        workspace_set_active: null,
        workspace_cwd_exists: true,
      },
    });
    await waitFor(() => expect(content().textContent).toContain("Its folder isn't where Plyloft left it"));
    expect(content().textContent).not.toContain("Added");
    const box = screen.getByRole("checkbox", { name: /app/ }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    await user.click(box);
    await user.click(screen.getByRole("button", { name: "Get 1 project" }));
    await waitFor(() => expect(toastTitles()).toContain("app cloned again"));
    await waitFor(() => expect(useWorkspaces.getState().activeId).toBe("w-app"));
  });

  describe("the only project to get starts ticked", () => {
    const joined = { team: { ...DEFAULT_SETTINGS.team, workMode: "team" as const, teamRepo: TEAM }, projects: { ...DEFAULT_SETTINGS.projects, folder: "~/Projects" } };
    const fixtures = { team_join_workspace_invites: { accepted: [], failed: [], pending: [] } };
    const box = (name: RegExp) => screen.getByRole("checkbox", { name }) as HTMLInputElement;

    it("ticks it, clones nothing until the press, and can be unticked", async () => {
      const { user } = await openStep({ settings: joined, team: () => joinedStatus({ workspaces: [ws("mb-adv/app")] }), fixtures });
      const get = (await screen.findByRole("button", { name: "Get 1 project" })) as HTMLButtonElement;
      expect(get.disabled).toBe(false);
      expect(box(/app/).checked).toBe(true);
      expect(tauri().callsOf("team_workspace_add")).toHaveLength(0);

      await user.click(box(/app/));
      expect(box(/app/).checked).toBe(false);
      expect((screen.getByRole("button", { name: "Get 0 projects" }) as HTMLButtonElement).disabled).toBe(true);
      expect(tauri().callsOf("team_workspace_add")).toHaveLength(0);
    });

    it("counts only what's left to get: one more beside one already added is ticked", async () => {
      await openStep({
        settings: joined,
        team: () => joinedStatus({ workspaces: [ws("mb-adv/app"), ws("mb-adv/site", { registered: true, cloned: true })] }),
        fixtures,
      });
      await screen.findByRole("button", { name: "Get 1 project" });
      expect(box(/app/).checked).toBe(true);
    });

    it("with several, ticks none", async () => {
      await openStep({ settings: joined, team: () => joinedStatus({ workspaces: [ws("mb-adv/app"), ws("mb-adv/site")] }), fixtures });
      expect(((await screen.findByRole("button", { name: "Get 0 projects" })) as HTMLButtonElement).disabled).toBe(true);
      expect(box(/app/).checked).toBe(false);
      expect(box(/site/).checked).toBe(false);
    });

    it("a project that can't be got isn't ticked", async () => {
      await openStep({
        settings: joined,
        team: () => joinedStatus({ workspaces: [ws("mb-adv/app", { conflict: "Another folder is already there" })] }),
        fixtures,
      });
      expect(((await screen.findByRole("button", { name: "Get 0 projects" })) as HTMLButtonElement).disabled).toBe(true);
    });
  });

  it("U7: Get 2 projects opens the first of them", async () => {
    const lyra = { id: "w-app", name: "app", cwd: "/p/app", createdAt: 1, lastOpenedAt: 1, openFiles: [], activeFile: null };
    const site = { ...lyra, id: "w-site", name: "site", cwd: "/p/site" };
    let adds = 0;
    tauri().allowUnhandled();
    const { user } = await openStep({
      settings: { team: { ...DEFAULT_SETTINGS.team, workMode: "team", teamRepo: TEAM }, projects: { ...DEFAULT_SETTINGS.projects, folder: "~/Projects" } },
      team: () => joinedStatus({ workspaces: [ws("mb-adv/app"), ws("mb-adv/site")] }),
      fixtures: {
        team_join_workspace_invites: { accepted: [], failed: [], pending: [] },
        team_workspace_add: ({ repo }: Record<string, unknown>) => {
          adds += 1;
          const name = String(repo).split("/")[1];
          return { repo, path: `/p/${name}`, name, cloned: true, registered: true, membershipFromCache: false };
        },
        workspace_list: () => ({ workspaces: adds > 0 ? [lyra, site] : [], activeId: null }),
        workspace_set_active: null,
        workspace_cwd_exists: true,
        team_invite_code: { code: "ply-join:mb-adv/ply-team", message: "m" },
      },
    });
    await waitFor(() => expect(content().textContent).toContain("The team's projects"));
    await user.click(screen.getByRole("checkbox", { name: /app/ }));
    await user.click(screen.getByRole("checkbox", { name: /site/ }));
    await user.click(screen.getByRole("button", { name: "Get 2 projects" }));
    await waitFor(() => expect(useWorkspaces.getState().activeId).toBe("w-app"));
    expect(tauri().callsOf("workspace_set_active")[0].args).toEqual({ id: "w-app" });
    expect(useUi.getState().centerMode["w-app"]).toBe("board");
  });

  it("the team's projects: a waiting invitation is accepted after its sheet, the folder is asked inline, then the project is got", async () => {
    const { user } = await openStep({
      settings: { team: { ...DEFAULT_SETTINGS.team, workMode: "team", teamRepo: TEAM } },
      team: () => joinedStatus({ workspaces: [ws("mb-adv/app"), ws("mb-adv/site", { registered: true, cloned: true })] }),
      fixtures: {
        team_join_workspace_invites: { accepted: [], failed: [], pending: [{ id: 7, repo: "mb-adv/app", inviter: "mb-adv" }] },
        team_join_accept_workspaces: { accepted: ["mb-adv/app"], failed: [], pending: [] },
        team_workspace_add: { repo: "mb-adv/app", path: "/Users/me/Projects/app", name: "app", cloned: true, registered: true, membershipFromCache: false },
        team_invite_code: { code: "ply-join:mb-adv/ply-team", message: "m" },
        // 1.175.0 F2: the same Projects folder row as Your first project.
        projects_folder_create: "/Users/me/Projects",
      },
    });
    await waitFor(() => expect(content().textContent).toContain("The team's projects"));
    expect(content().textContent).toContain("Invitation waiting");
    expect(content().textContent).toContain("New projects and the ones you get from GitHub go here.");
    expect(content().textContent).toContain("Added");
    // Step 7 isn't done: the folder is asked here.
    expect(content().textContent).toContain("~/Projects");
    await user.click(screen.getByRole("button", { name: "Get 1 project" }));
    const sheet = await screen.findByRole("dialog", { name: "Accept the invitation?" });
    expect(sheet.textContent).toContain("Plyloft will accept your GitHub invitation to mb-adv/app (from mb-adv).");
    expect(tauri().callsOf("team_join_accept_workspaces")).toHaveLength(0);
    await user.click(within(sheet).getByRole("button", { name: "Accept and get it" }));
    await waitFor(() => expect(tauri().callsOf("team_workspace_add")).toHaveLength(1));
    expect(tauri().callsOf("team_join_accept_workspaces")[0].args).toEqual({ repos: ["mb-adv/app"], account: null });
    expect(tauri().callsOf("team_workspace_add")[0].args).toEqual({ repo: "mb-adv/app" });
    // The folder was made and written before the clone.
    const saved = tauri().callsOf("settings_set").map((c) => (c.args.settings as Settings).projects?.folder);
    expect(saved).toContain("~/Projects");
    expect(tauri().callsOf("projects_folder_create")[0].args).toEqual({ folder: "~/Projects" });
    const order = tauri().calls.map((c) => c.cmd);
    expect(order.indexOf("projects_folder_create")).toBeLessThan(order.indexOf("team_workspace_add"));
    expect(useSettings.getState().settings.projects?.folder).toBe("~/Projects");
  });

  // F2 round 2 (review): the team's clone reads the setting, so it is
  // written for the attempt — and put back when nothing landed.
  it("the team's projects: a get that lands nothing leaves the folder setting as it was", async () => {
    const { user } = await openStep({
      settings: { team: { ...DEFAULT_SETTINGS.team, workMode: "team", teamRepo: TEAM } },
      team: () => joinedStatus({ workspaces: [ws("mb-adv/app")] }),
      fixtures: {
        team_workspace_add: () => {
          throw new Error("GitHub couldn't be reached.");
        },
        team_invite_code: { code: "ply-join:mb-adv/ply-team", message: "m" },
        projects_folder_create: "/Users/me/Projects",
      },
    });
    await waitFor(() => expect(content().textContent).toContain("The team's projects"));
    await user.click(screen.getByRole("button", { name: "Get 1 project" }));
    await waitFor(() => expect(tauri().callsOf("team_workspace_add")).toHaveLength(1));
    await waitFor(() => expect(useSettings.getState().settings.projects?.folder ?? null).toBeNull());
    const saved = tauri().callsOf("settings_set").map((c) => (c.args.settings as Settings).projects?.folder ?? null);
    expect(saved[saved.length - 1]).toBeNull();
  });

  // F2 review (round 3): the clone root the safeguard pinned for the folder
  // goes back with it.
  it("the team's projects: a get that lands nothing puts the clone root back too", async () => {
    const { user } = await openStep({
      settings: { team: { ...DEFAULT_SETTINGS.team, workMode: "team", teamRepo: TEAM } },
      team: () =>
        joinedStatus({ cloneRoot: "~/code", workspaces: [ws("mb-adv/app"), ws("mb-adv/site", { registered: true, cloned: true })] }),
      fixtures: {
        team_workspace_add: () => {
          throw new Error("GitHub couldn't be reached.");
        },
        team_invite_code: { code: "ply-join:mb-adv/ply-team", message: "m" },
        projects_folder_create: "/Users/me/Projects",
      },
    });
    await waitFor(() => expect(content().textContent).toContain("The team's projects"));
    await user.click(screen.getByRole("button", { name: "Get 1 project" }));
    await waitFor(() => expect(tauri().callsOf("team_workspace_add")).toHaveLength(1));
    // The safeguard pinned it for the attempt…
    const roots = () => tauri().callsOf("settings_set").map((c) => (c.args.settings as Settings).team?.cloneRoot ?? null);
    await waitFor(() => expect(roots()).toContain("~/code"));
    // …and nothing landed: both go back.
    await waitFor(() => expect(useSettings.getState().settings.team?.cloneRoot ?? null).toBeNull());
    expect(useSettings.getState().settings.projects?.folder ?? null).toBeNull();
  });
});

// ── 1.176.3: the step says why it is there; Not now is an answer ─────────

describe("Setup step 6, why it is there and Not now (1.176.3)", () => {
  const listed = { read: true, login: "mb-member", teams: [TEAM], invitations: 0, problem: null };
  const savedSkips = () =>
    tauri()
      .callsOf("settings_set")
      .map((c) => (c.args.settings as Settings).onboarding?.skipped?.team)
      .filter(Boolean);
  const FOUND: JoinDetection = { ...NOTHING, teams: [{ repo: TEAM, name: "MB Adv", owner: "mb-adv", current: false }] };
  const solo = { team: { ...DEFAULT_SETTINGS.team, workMode: null } };
  const soloFixtures = { team_work_mode: { mode: "solo", chosen: false } };
  const foot = () => document.querySelector(".ux-setup-foot") as HTMLElement;
  const READY_PREVIEW = () => ({
    kind: "ready" as const,
    team: facts,
    workspaceInvites: [],
    replaces: null,
    alreadyIn: false,
    calls: [],
  });
  /** Setup reads GitHub's answer once past step 5; then the Team step. */
  async function openTeamAfterHint(hint: unknown, o: Partial<Opts> = {}) {
    act(() => useWorkMode.setState({ mode: "solo", chosen: false }));
    const r = await openStep({ step: "ai", settings: solo, ...o, fixtures: { ...soloFixtures, setup_team_hint: hint, ...o.fixtures } });
    tauri().allowUnhandled();
    await waitFor(() => expect(tauri().callsOf("setup_team_hint")).toHaveLength(1));
    await r.user.click(within(stepList()).getByRole("button", { name: /Your team/ }));
    await waitFor(() => expect(stepTitle()).toBe("Your team"));
    return r;
  }
  const lede = () => screen.getByRole("dialog", { name: "Setup" }).textContent;

  it("a listed team: the lede names it; its option is chosen and named, Not now is an option, no Skip for now, Continue is enabled; nothing looked up", async () => {
    await openTeamAfterHint(listed, { detect: FOUND });
    await waitFor(() =>
      expect(lede()).toContain(`GitHub lists you in a Plyloft team: ${TEAM}. You can join it without an invite code, or set it aside for now.`),
    );
    const join = screen.getByRole("radio", { name: /Join ply-team/ }) as HTMLInputElement;
    expect(join.checked || join.getAttribute("aria-checked") === "true").toBe(true);
    expect(screen.getByRole("radio", { name: /Not now/ })).toBeTruthy();
    expect(screen.getByText(/Add the team any time in Settings › Team › Members and library\./)).toBeTruthy();
    expect(within(foot()).queryByRole("button", { name: "Skip for now" })).toBeNull();
    expect((within(foot()).getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(false);
    expect(tauri().callsOf("team_join_detect")).toHaveLength(0);
  });

  it("several teams: one named option each, the first chosen; Continue opens the sheet of the CHOSEN one", async () => {
    const { user } = await openTeamAfterHint({ ...listed, teams: [TEAM, "mb-adv/other"] }, { preview: READY_PREVIEW });
    await waitFor(() => expect(lede()).toContain("GitHub lists you in Plyloft teams: mb-adv/ply-team, mb-adv/other. You can join one of them"));
    await user.click(screen.getByRole("radio", { name: /Join other/ }));
    await user.click(within(foot()).getByRole("button", { name: "Continue" }));
    await screen.findByRole("dialog", { name: /Join the team at/ });
    expect(tauri().callsOf("team_join_preview")[0].args).toEqual({ code: "mb-adv/other", account: null });
    expect(tauri().callsOf("team_join_confirm")).toHaveLength(0);
  });

  it("an invitation waits: the lede says so, Join is chosen with its code field, and the footer's Continue asks with the typed code", async () => {
    const { user } = await openTeamAfterHint({ ...listed, teams: [], invitations: 1 }, { preview: READY_PREVIEW });
    await waitFor(() => expect(lede()).toContain("GitHub shows an invitation to a Plyloft team. Paste the invite code your team's owner sent you"));
    await user.type(await screen.findByRole("textbox", { name: "Invite code" }), `ply-join:${TEAM}`);
    await user.click(within(foot()).getByRole("button", { name: "Continue" }));
    await screen.findByRole("dialog", { name: /Join the team at/ });
    expect(tauri().callsOf("team_join_preview")[0].args).toEqual({ code: `ply-join:${TEAM}`, account: null });
    expect(stepTitle()).toBe("Your team");
  });

  it("nothing chosen, nothing found: no lookup; Continue says to choose, and does not move on", async () => {
    const { user } = await openStep({});
    expect(tauri().callsOf("team_join_detect")).toHaveLength(0);
    await user.click(within(foot()).getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("Choose one of the options above, or press Not now.")).toBeTruthy();
    expect(stepTitle()).toBe("Your team");
    // Join chosen, no team and no code: one plain line.
    await user.click(screen.getByRole("radio", { name: /Join a team/ }));
    await waitFor(() => expect(tauri().callsOf("team_join_detect")).toHaveLength(1));
    await screen.findByText("No team found that lists you yet.");
    await user.click(within(foot()).getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("Paste an invite code, or press Not now.")).toBeTruthy();
    expect(stepTitle()).toBe("Your team");
  });

  it("a refused ask is said once; the next Continue moves on", async () => {
    const { user } = await openTeamAfterHint(listed, {
      preview: () => ({ kind: "problem", problem: problem("no-access", "GitHub hasn't given you access.") }),
    });
    await user.click(within(foot()).getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(tauri().callsOf("team_join_preview")).toHaveLength(1));
    await screen.findByText(/GitHub hasn't given you access/);
    expect(stepTitle()).toBe("Your team");
    await user.click(within(foot()).getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(stepTitle()).not.toBe("Your team"));
    expect(tauri().callsOf("team_join_preview")).toHaveLength(1);
  });

  it("a lookup that failed is said once; the next Continue moves on", async () => {
    const { user } = await openStep({ detect: { ...NOTHING, problem: problem("other", "Plyloft couldn't look for your teams.") } });
    await user.click(screen.getByRole("radio", { name: /Join a team/ }));
    await waitFor(() => expect(tauri().callsOf("team_join_detect")).toHaveLength(1));
    await user.click(within(foot()).getByRole("button", { name: "Continue" }));
    expect(await screen.findByText(/Press Continue again to go on without a team/)).toBeTruthy();
    await user.click(within(foot()).getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(stepTitle()).not.toBe("Your team"));
  });

  it("once this computer is in the team the lede is the general one", async () => {
    await openTeamAfterHint(listed, { team: () => joinedStatus() });
    await waitFor(() => expect(content().textContent).toContain("You're in “MB Adv”."));
    expect(lede()).not.toContain("You can join it");
    expect(lede()).toContain("A Plyloft team is a private GitHub repository");
  });

  it("Not now then Continue saves what Skip for now saved, and moves on", async () => {
    const { user } = await openStep({ detect: FOUND });
    await user.click(screen.getByRole("radio", { name: /Not now/ }));
    await user.click(within(foot()).getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(savedSkips().length).toBeGreaterThan(0));
    expect(tauri().callsOf("team_join_preview")).toHaveLength(0);
    await waitFor(() => expect(stepTitle()).not.toBe("Your team"));
  });

  it("Connect GitHub first offers Not now too", async () => {
    const { user } = await openStep({ github: SIGNED_OUT });
    await waitFor(() => expect(content().textContent).toContain("Connect GitHub first."));
    await user.click(within(content()).getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(savedSkips().length).toBeGreaterThan(0));
  });
});
