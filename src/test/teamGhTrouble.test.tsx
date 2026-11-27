// N14 walk F16 (VM member walk, 2026-10-02): Settings › Team on a Mac/PC
// where the GitHub command isn't signed in. The status box says so in one plain
// line ("this PC" on Windows) with one way out — Setup › GitHub for pull
// requests — and keeps gh's raw words behind Show details, instead of three
// raw errors and "GitHub account unknown". Git couldn't sign in (GCM) is a
// second case with its own words. Back from Setup the page reads again.
import { afterEach, describe, expect, it } from "vitest";
import { TeamPage } from "../components/settings/TeamPage";
import type { LicenseInfo, TeamStatus } from "../ipc";
import { useLicense } from "../store/licenseStore";
import { useSetup } from "../store/setupStore";
import { setPlatformForTests } from "../lib/platform";
import { DEFAULT_SETTINGS, useSettings } from "../store/settingsStore";
import { act, renderUi, screen, waitFor } from "./render";
import { setTeamAllowed } from "./planGates";

afterEach(() => setPlatformForTests(null));

const LICENSE = { status: "valid", team: "Plyloft test team", teamRepo: "boss/team" } as unknown as LicenseInfo;

const GIT_AUTH_WORDS =
  'Git couldn\'t sign in to GitHub. In Settings › Setup and account › Setup › GitHub, turn on "Git uses your GitHub sign-in", then try again.';
const GH_START =
  "To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.";
const WALK_ERROR = [
  `Could not pull the team repo: ${GIT_AUTH_WORDS}`,
  `Could not read your GitHub login: ${GH_START}`,
  `Could not check access to boss/team: ${GH_START}`,
].join(" ");

function memberStatus(over: Partial<TeamStatus> = {}): TeamStatus {
  return {
    teamRepo: "boss/team",
    teamName: "Plyloft test team",
    ownerLogin: "boss",
    members: [
      { login: "boss", owner: true },
      { login: "friend", owner: false },
    ],
    isOwner: false,
    ignoredRepos: [],
    login: null,
    membership: "unknown",
    membershipReason: null,
    membershipStale: false,
    cloneRoot: "/Users/me/code",
    cloneRootIsDefault: true,
    hasClone: true,
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

function openPage(refreshed: () => TeamStatus) {
  useLicense.setState({ info: LICENSE, loaded: true } as never);
  setTeamAllowed(true);
  return renderUi(<TeamPage scope="team" />, {
    fixtures: {
      team_status: () => memberStatus(),
      team_refresh: refreshed,
      team_work_mode: { mode: "team", chosen: true },
      team_member_states: { members: [], problems: [] },
    },
  });
}

const box = () => document.querySelector("[data-ply-gh-trouble]") as HTMLElement | null;

describe("N14 walk F16: Settings › Team when gh isn't signed in", () => {
  it("says it in one line with Sign in to GitHub, the raw words behind Show details", async () => {
    let answer = memberStatus({ error: WALK_ERROR });
    const { user, tauri } = openPage(() => answer);
    const line = await screen.findByText(
      "The GitHub command isn't signed in on this Mac, so Plyloft can't read the team.",
    );
    expect(box()?.dataset.plyGhTrouble).toBe("gh-signed-out");
    // No "GitHub account unknown", no "Checking…".
    const status = box()!.parentElement as HTMLElement;
    expect(status.contains(line)).toBe(true);
    expect(status.textContent).not.toContain("GitHub account unknown");
    expect(status.textContent).not.toContain("Checking…");
    expect(status.textContent).toContain("Membership of boss/team not checked");
    // The raw messages are in Details, closed, one per line.
    const details = box()!.querySelector("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")?.textContent).toContain("Show details");
    const raw = details.querySelector("pre")!.textContent!;
    expect(raw.split("\n").filter((l) => l.startsWith("Could not "))).toHaveLength(3);
    expect(raw).toContain("gh auth login");
    // Outside Details, none of gh's words.
    const visible = status.textContent!.replace(details.textContent!, "");
    expect(visible).not.toContain("gh auth login");
    expect(visible).not.toContain("Could not");

    // One action: Setup › GitHub for pull requests.
    const buttons = Array.from(box()!.querySelectorAll("button")).map((b) => b.textContent);
    expect(buttons).toEqual(["Sign in to GitHub"]);
    await user.click(screen.getByRole("button", { name: "Sign in to GitHub" }));
    expect(useSetup.getState()).toMatchObject({ open: true, setupCase: "rerun", step: "github" });

    // Back from Setup signed in: the page reads the team again.
    const before = tauri.callsOf("team_refresh").length;
    answer = memberStatus({ login: "friend", membership: "member" });
    act(() => useSetup.getState().closeSetup());
    await waitFor(() => expect(tauri.callsOf("team_refresh").length).toBe(before + 1));
    await waitFor(() => expect(box()).toBeNull());
    expect(screen.queryByText(/isn't signed in/)).toBeNull();
  });

  it("says this PC on Windows", async () => {
    setPlatformForTests("windows");
    openPage(() => memberStatus({ error: WALK_ERROR }));
    expect(
      await screen.findByText("The GitHub command isn't signed in on this PC, so Plyloft can't read the team."),
    ).toBeTruthy();
  });

  it("Git couldn't sign in (GCM) keeps its own words, with Setup › GitHub as the way out", async () => {
    const { user } = openPage(() =>
      memberStatus({ login: "friend", membership: "member", error: `Could not pull the team repo: ${GIT_AUTH_WORDS}` }),
    );
    expect(await screen.findByText(GIT_AUTH_WORDS)).toBeTruthy();
    expect(box()?.dataset.plyGhTrouble).toBe("git-sign-in");
    await user.click(screen.getByRole("button", { name: "Open GitHub setup" }));
    expect(useSetup.getState()).toMatchObject({ open: true, step: "github" });
  });

  it("an expired sign-in says so, and a distinct error beside it still shows", async () => {
    openPage(() =>
      memberStatus({
        error:
          "Could not read your GitHub login: HTTP 401: Bad credentials (https://api.github.com/user)\nTry authenticating with:  gh auth login Could not read team.json: HTTP 404: Not Found",
      }),
    );
    expect(
      await screen.findByText(
        "The GitHub command's sign-in on this Mac has expired or was revoked, so Plyloft can't read the team.",
      ),
    ).toBeTruthy();
    expect(box()?.dataset.plyGhTrouble).toBe("gh-expired");
    expect(screen.getByText("Could not read team.json: HTTP 404: Not Found")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign in to GitHub" })).toBeTruthy();
  });

  it("any other error stays as it is", async () => {
    openPage(() => memberStatus({ login: "friend", membership: "member", error: "Could not pull the team repo: GitHub didn't answer in time." }));
    expect(await screen.findByText("Could not pull the team repo: GitHub didn't answer in time.")).toBeTruthy();
    expect(box()).toBeNull();
  });

  // N14 walk F16b (Windows VM, 2026-10-02 21:07): the team joined with an
  // account gh hasn't signed in. Plyloft's team scope words arrived three
  // times under "Checking… GitHub account unknown", with no way out.
  it("the team's account not signed in: one line naming it, Sign in to GitHub, the reason once in Details", async () => {
    setPlatformForTests("windows");
    const TEAM_WORDS =
      "Your team uses the GitHub account test-owner, which isn't signed in on this PC. Sign it in in Setup's GitHub step, or leave the team and join it again with another account.";
    const error = [
      `Could not pull the team repo: git fetch: ${TEAM_WORDS}`,
      `Could not read your GitHub login: ${TEAM_WORDS}`,
      `Could not check access to test-owner/plyloft-test-team: ${TEAM_WORDS}`,
    ].join(" ");
    const { user } = openPage(() =>
      memberStatus({ teamRepo: "test-owner/plyloft-test-team", ownerLogin: "test-owner", error }),
    );
    const line = await screen.findByText(
      "The GitHub account test-owner isn't signed in on this PC, so Plyloft can't read the team.",
    );
    expect(box()?.dataset.plyGhTrouble).toBe("gh-signed-out");
    const status = box()!.parentElement as HTMLElement;
    expect(status.contains(line)).toBe(true);
    expect(status.textContent).not.toContain("Checking…");
    expect(status.textContent).not.toContain("GitHub account unknown");
    expect(status.textContent).toContain(
      "Membership of test-owner/plyloft-test-team not checked · owned by test-owner",
    );
    // The sentence once, in Details; nothing raw outside it.
    const details = box()!.querySelector("details") as HTMLDetailsElement;
    const raw = details.querySelector("pre")!.textContent!;
    expect(raw.split(TEAM_WORDS)).toHaveLength(2);
    expect(raw).toContain("Could not pull the team repo (git fetch)");
    expect(raw).toContain("Could not check access to test-owner/plyloft-test-team");
    const visible = status.textContent!.replace(details.textContent!, "");
    expect(visible).not.toContain("Your team uses");
    expect(visible).not.toContain("Could not");
    const buttons = Array.from(box()!.querySelectorAll("button")).map((b) => b.textContent);
    expect(buttons).toEqual(["Sign in to GitHub"]);
    await user.click(screen.getByRole("button", { name: "Sign in to GitHub" }));
    expect(useSetup.getState()).toMatchObject({ open: true, setupCase: "rerun", step: "github" });
  });
});

// N14 walk F16c (Windows VM, 2026-10-05): gh signed out with `gh auth logout`,
// yet gh's config still named the team's account with no token gh could read:
// GitHub answered gh's tokenless call "Requires authentication (HTTP 401)" and
// git couldn't sign in. The page showed Git's GCM words, the raw 401 outside
// Show details, and "Checking… GitHub account unknown" first.
describe("N14 walk F16c: the team's account has no usable sign-in", () => {
  const ACCOUNT = "test-user";
  const REPO = "test-owner/plyloft-test-team";
  const HTTP_401 = "Could not read your GitHub login: gh: Requires authentication (HTTP 401)";
  const F16C_ERROR = `Could not pull the team repo: ${GIT_AUTH_WORDS} ${HTTP_401}`;

  function withAccount(account: string | null) {
    useSettings.setState({
      settings: { ...DEFAULT_SETTINGS, team: { ...DEFAULT_SETTINGS.team, teamRepo: REPO, account } },
      loaded: true,
    } as never);
  }
  afterEach(() => useSettings.setState({ settings: { ...DEFAULT_SETTINGS }, loaded: true } as never));

  for (const [platform, machine] of [
    ["mac", "Mac"],
    ["windows", "PC"],
  ] as const) {
    it(`one line naming the account on this ${machine}, Sign in to GitHub, the raw words once in Details`, async () => {
      setPlatformForTests(platform);
      withAccount(ACCOUNT);
      const { user } = openPage(() =>
        memberStatus({ teamRepo: REPO, ownerLogin: "test-owner", error: F16C_ERROR }),
      );
      const line = await screen.findByText(
        `The GitHub account ${ACCOUNT} isn't signed in on this ${machine}, so Plyloft can't read the team.`,
      );
      expect(box()?.dataset.plyGhTrouble).toBe("gh-signed-out");
      const status = box()!.parentElement as HTMLElement;
      expect(status.contains(line)).toBe(true);
      expect(status.textContent).toContain(`Membership of ${REPO} not checked · owned by test-owner`);
      expect(status.textContent).not.toContain("Checking");
      expect(status.textContent).not.toContain("GitHub account unknown");
      const details = box()!.querySelector("details") as HTMLDetailsElement;
      const raw = details.querySelector("pre")!.textContent!;
      expect(raw.split(HTTP_401)).toHaveLength(2);
      expect(raw.split(GIT_AUTH_WORDS)).toHaveLength(2);
      const visible = status.textContent!.replace(details.textContent!, "");
      expect(visible).not.toContain("Requires authentication");
      expect(visible).not.toContain("Git couldn't sign in");
      expect(visible).not.toContain("Could not");
      const buttons = Array.from(box()!.querySelectorAll("button")).map((b) => b.textContent);
      expect(buttons).toEqual(["Sign in to GitHub"]);
      await user.click(screen.getByRole("button", { name: "Sign in to GitHub" }));
      // Setup › GitHub is asked to sign in as the team's account.
      expect(useSetup.getState()).toMatchObject({
        open: true,
        setupCase: "rerun",
        step: "github",
        githubAccount: ACCOUNT,
      });
      act(() => useSetup.getState().closeSetup());
    });
  }

  it("a sign-in GitHub refuses names the account as expired, with Sign in to GitHub", async () => {
    setPlatformForTests("windows");
    withAccount(ACCOUNT);
    openPage(() =>
      memberStatus({
        teamRepo: REPO,
        error: `Could not pull the team repo: ${GIT_AUTH_WORDS} Could not read your GitHub login: gh: Bad credentials (HTTP 401)`,
      }),
    );
    expect(
      await screen.findByText(
        `The GitHub account ${ACCOUNT}'s sign-in on this PC has expired or was revoked, so Plyloft can't read the team.`,
      ),
    ).toBeTruthy();
    expect(box()?.dataset.plyGhTrouble).toBe("gh-expired");
    expect(screen.getByRole("button", { name: "Sign in to GitHub" })).toBeTruthy();
  });

  it("Git over SSH beside it keeps its own line", async () => {
    withAccount(ACCOUNT);
    const SSH = "Git couldn't sign in to GitHub over SSH. Check your SSH key, or use HTTPS with the GitHub command's sign-in.";
    openPage(() =>
      memberStatus({ teamRepo: REPO, error: `Could not pull the team repo: ${SSH} ${HTTP_401}` }),
    );
    expect(
      await screen.findByText(
        `The GitHub account ${ACCOUNT} isn't signed in on this Mac, so Plyloft can't read the team.`,
      ),
    ).toBeTruthy();
    expect(screen.getByText(`Could not pull the team repo: ${SSH}`)).toBeTruthy();
  });

  it("a read from GitHub that was rejected is not checked, never stuck on Checking", async () => {
    withAccount(ACCOUNT);
    useLicense.setState({ info: LICENSE, loaded: true } as never);
    setTeamAllowed(true);
    const { tauri } = renderUi(<TeamPage scope="team" />, {
      fixtures: {
        team_status: () => memberStatus({ teamRepo: REPO }),
        team_refresh: () => Promise.reject("join team refresh: worker gone"),
        team_work_mode: { mode: "team", chosen: true },
        team_member_states: { members: [], problems: [] },
      },
    });
    await waitFor(() => expect(tauri.callsOf("team_refresh").length).toBe(1));
    await waitFor(() => expect(document.body.textContent).toContain(`Membership of ${REPO} not checked`));
    expect(document.body.textContent).not.toContain("Checking membership");
    expect(document.body.textContent).not.toContain("GitHub account unknown");
  });

  it("GitHub answered nothing and nothing failed: not checked, never stuck on Checking", async () => {
    withAccount(ACCOUNT);
    openPage(() => memberStatus({ teamRepo: REPO, error: null }));
    await waitFor(() => expect(document.body.textContent).toContain(`Membership of ${REPO} not checked`));
    expect(document.body.textContent).not.toContain("Checking membership");
    expect(document.body.textContent).not.toContain("GitHub account unknown");
  });

  it("while checking it names the team's recorded account, not an older login", async () => {
    withAccount("new-acct");
    let answer: (status: TeamStatus) => void = () => {};
    const pending = new Promise<TeamStatus>((resolve) => (answer = resolve));
    useLicense.setState({ info: LICENSE, loaded: true } as never);
    setTeamAllowed(true);
    renderUi(<TeamPage scope="team" />, {
      fixtures: {
        // The cached answer still carries the account joined before.
        team_status: () => memberStatus({ teamRepo: REPO, login: "old-acct" }),
        team_refresh: () => pending,
        team_work_mode: { mode: "team", chosen: true },
        team_member_states: { members: [], problems: [] },
      },
    });
    const checking = await screen.findByText(/Checking membership of/);
    const line = checking.closest(".ux-status-line") ?? checking;
    expect(line.textContent).toContain(`Checking membership of ${REPO} as new-acct…`);
    expect(line.textContent).not.toContain("old-acct");
    await act(async () => answer(memberStatus({ teamRepo: REPO, login: "new-acct", membership: "member" })));
  });

  it("gh signed in and Git (GCM) couldn't sign in still keeps F16's own words", async () => {
    withAccount(ACCOUNT);
    openPage(() =>
      memberStatus({
        teamRepo: REPO,
        login: ACCOUNT,
        membership: "member",
        error: `Could not pull the team repo: ${GIT_AUTH_WORDS}`,
      }),
    );
    expect(await screen.findByText(GIT_AUTH_WORDS)).toBeTruthy();
    expect(box()?.dataset.plyGhTrouble).toBe("git-sign-in");
    expect(screen.queryByText(/isn't signed in/)).toBeNull();
  });

  it("while the read runs: Checking membership of the repo as the team's account, never account unknown", async () => {
    withAccount(ACCOUNT);
    let answer: (status: TeamStatus) => void = () => {};
    const pending = new Promise<TeamStatus>((resolve) => (answer = resolve));
    useLicense.setState({ info: LICENSE, loaded: true } as never);
    setTeamAllowed(true);
    const { tauri } = renderUi(<TeamPage scope="team" />, {
      fixtures: {
        team_status: () => memberStatus({ teamRepo: REPO, ownerLogin: "test-owner" }),
        team_refresh: () => pending,
        team_work_mode: { mode: "team", chosen: true },
        team_member_states: { members: [], problems: [] },
      },
    });
    await waitFor(() => expect(tauri.callsOf("team_refresh").length).toBe(1));
    const checking = await screen.findByText(/Checking membership of/);
    const line = checking.closest(".ux-status-line") ?? checking;
    expect(line.textContent).toContain(`Checking membership of ${REPO} as ${ACCOUNT}…`);
    expect(document.body.textContent).not.toContain("GitHub account unknown");
    await act(async () =>
      answer(memberStatus({ teamRepo: REPO, ownerLogin: "test-owner", error: F16C_ERROR })),
    );
    expect(
      await screen.findByText(
        `The GitHub account ${ACCOUNT} isn't signed in on this Mac, so Plyloft can't read the team.`,
      ),
    ).toBeTruthy();
    expect(document.body.textContent).not.toContain("Checking membership");
  });

  it("with no account recorded, the reading line names none", async () => {
    withAccount(null);
    let answer: (status: TeamStatus) => void = () => {};
    const pending = new Promise<TeamStatus>((resolve) => (answer = resolve));
    useLicense.setState({ info: LICENSE, loaded: true } as never);
    setTeamAllowed(true);
    renderUi(<TeamPage scope="team" />, {
      fixtures: {
        team_status: () => memberStatus({ teamRepo: REPO }),
        team_refresh: () => pending,
        team_work_mode: { mode: "team", chosen: true },
        team_member_states: { members: [], problems: [] },
      },
    });
    const checking = await screen.findByText(/Checking membership of/);
    expect(checking.textContent).not.toContain(" as ");
    expect(document.body.textContent).not.toContain("GitHub account unknown");
    await act(async () => answer(memberStatus({ teamRepo: REPO, login: "friend", membership: "member" })));
  });
});
