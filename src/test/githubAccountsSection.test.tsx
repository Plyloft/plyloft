// OB-7b (ONBOARDING_SPEC §5 step 5 "Several accounts", §9.2): Settings ›
// Account › Setup's GitHub accounts — nothing with one account; with several,
// gh's accounts, Add another account (Setup's GitHub step), and per workspace
// with a GitHub origin the account Plyloft's own GitHub calls use, written
// through workspace_set_github_account. And the claim chip says "Yours" for
// the workspace's own account.
import { describe, expect, it } from "vitest";
import {
  ACTIVE_ACCOUNT,
  GitHubAccountsSection,
  accountChoiceNeeded,
  accountOptions,
  workspaceHint,
} from "../components/settings/GitHubAccountsSection";
import { SetupPage } from "../components/settings/SetupPage";
import { CardClaimControl } from "../components/CardClaimChip";
import { useSetup } from "../store/setupStore";
import { useWorkspaces } from "../store/workspaceStore";
import { useIdentity } from "../store/identityStore";
import type { GithubAccount, GithubStatus, KanbanCard, WorkspaceGithub } from "../ipc";
import { renderUi, screen, waitFor, within } from "./render";

const acct = (login: string, over: Partial<GithubAccount> = {}): GithubAccount => ({
  login,
  active: false,
  state: "signed-in",
  scopes: "repo, read:org",
  ...over,
});

const status = (accounts: GithubAccount[] | null): GithubStatus => ({
  ghFound: true,
  accounts,
  helper: "gh",
  githubEmail: null,
  githubNoreply: null,
  sso: null,
});

const TWO = [acct("main-acct", { active: true }), acct("work-acct")];

const rows: WorkspaceGithub[] = [
  { id: "a", name: "Lyra", repo: "acme/lyra", ssh: false, account: null },
  { id: "b", name: "Vega", repo: "me/vega", ssh: true, account: "work-acct" },
];

function fixtures(accounts: GithubAccount[] | null, list: WorkspaceGithub[] = rows) {
  return {
    setup_github_status: status(accounts),
    github_account_workspaces: list,
    workspace_set_github_account: null,
    workspace_list: { workspaces: [], activeWorkspaceId: null },
  };
}

describe("GitHubAccountsSection", () => {
  it("shows nothing extra with one account, and never lists the workspaces", async () => {
    const r = renderUi(<GitHubAccountsSection />, { fixtures: fixtures([acct("main-acct", { active: true })]) });
    await waitFor(() => expect(r.tauri.callsOf("setup_github_status")).toHaveLength(1));
    expect(screen.queryByText("Account for each project")).toBeNull();
    expect(r.tauri.callsOf("github_account_workspaces")).toHaveLength(0);
  });

  it("shows nothing when gh's answer couldn't be read", async () => {
    const r = renderUi(<GitHubAccountsSection />, { fixtures: fixtures(null) });
    await waitFor(() => expect(r.tauri.callsOf("setup_github_status")).toHaveLength(1));
    expect(screen.queryByText("Account for each project")).toBeNull();
  });

  it("lists the accounts and each GitHub workspace's account with several", async () => {
    renderUi(<GitHubAccountsSection />, { fixtures: fixtures(TWO) });
    expect(await screen.findByText("Account for each project")).toBeTruthy();
    expect(screen.getByText("Signed in with 2 accounts: main-acct (active), work-acct.")).toBeTruthy();
    const lyra = (await screen.findByRole("combobox", { name: "GitHub account for Lyra" })) as HTMLSelectElement;
    expect(lyra.value).toBe(ACTIVE_ACCOUNT);
    expect(within(lyra).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Active account (main-acct)",
      "main-acct",
      "work-acct",
    ]);
    const vega = screen.getByRole("combobox", { name: "GitHub account for Vega" }) as HTMLSelectElement;
    expect(vega.value).toBe("work-acct");
    expect(screen.getByText("acme/lyra")).toBeTruthy();
    expect(
      screen.getByText("me/vega · Pushes and fetches use your SSH keys; Plyloft's other GitHub calls use this account."),
    ).toBeTruthy();
  });

  it("writes the chosen login, and the active account as none", async () => {
    const r = renderUi(<GitHubAccountsSection />, { fixtures: fixtures(TWO) });
    const lyra = await screen.findByRole("combobox", { name: "GitHub account for Lyra" });
    await r.user.selectOptions(lyra, "work-acct");
    await waitFor(() =>
      expect(r.tauri.callsOf("workspace_set_github_account").map((c) => c.args)).toEqual([
        { id: "a", login: "work-acct" },
      ]),
    );
    await waitFor(() => expect((lyra as HTMLSelectElement).value).toBe("work-acct"));
    const vega = screen.getByRole("combobox", { name: "GitHub account for Vega" });
    await r.user.selectOptions(vega, ACTIVE_ACCOUNT);
    await waitFor(() =>
      expect(r.tauri.callsOf("workspace_set_github_account").map((c) => c.args)[1]).toEqual({
        id: "b",
        login: null,
      }),
    );
  });

  it("says so when the write fails, and keeps the old choice", async () => {
    const r = renderUi(<GitHubAccountsSection />, {
      fixtures: {
        ...fixtures(TWO),
        workspace_set_github_account: () => {
          throw new Error("workspace not found");
        },
      },
      withToasts: true,
    });
    const lyra = (await screen.findByRole("combobox", { name: "GitHub account for Lyra" })) as HTMLSelectElement;
    await r.user.selectOptions(lyra, "work-acct");
    // 1.176.2 (E1): the toast now has a body (the cause), so its title ends in a full stop.
    expect(await screen.findByText("Couldn't change Lyra's GitHub account.")).toBeTruthy();
    expect(lyra.value).toBe(ACTIVE_ACCOUNT);
  });

  it("keeps a chosen login gh no longer lists visible, and says its calls stop", async () => {
    renderUi(<GitHubAccountsSection />, {
      fixtures: fixtures(TWO, [{ id: "c", name: "Old", repo: "o/old", ssh: false, account: "gone-acct" }]),
    });
    const old = (await screen.findByRole("combobox", { name: "GitHub account for Old" })) as HTMLSelectElement;
    expect(old.value).toBe("gone-acct");
    expect(within(old).getByRole("option", { name: "gone-acct (not signed in)" })).toBeTruthy();
    expect(screen.getByText(/gone-acct isn't signed in on this computer/)).toBeTruthy();
  });

  it("says when no workspace has a GitHub origin", async () => {
    renderUi(<GitHubAccountsSection />, { fixtures: fixtures(TWO, []) });
    expect(await screen.findByText("No project is on GitHub yet.")).toBeTruthy();
  });

  // 1.176.2 (E1, A3-71): a read that failed is not "no project is on GitHub".
  it("says when the read failed, and reads again on the press", async () => {
    let fail = true;
    const r = renderUi(<GitHubAccountsSection />, {
      fixtures: {
        ...fixtures(TWO),
        github_account_workspaces: () => {
          if (fail) throw new Error("gh: HTTP 502");
          return rows;
        },
      },
    });
    expect(await screen.findByText("Plyloft couldn't read your projects' GitHub accounts.")).toBeTruthy();
    expect(screen.queryByText("No project is on GitHub yet.")).toBeNull();
    fail = false;
    await r.user.click(screen.getByRole("button", { name: "Read it again" }));
    expect(await screen.findByRole("combobox", { name: "GitHub account for Lyra" })).toBeTruthy();
  });

  it("Add another account opens Setup on its GitHub step", async () => {
    const r = renderUi(<GitHubAccountsSection />, { fixtures: fixtures(TWO) });
    const add = await screen.findByRole("button", { name: "Add another account" });
    // F6: the same kind of button as Manage beside it on the Setup page (bordered).
    expect(add.classList.contains("cbtn--quiet")).toBe(false);
    await r.user.click(add);
    expect(useSetup.getState()).toMatchObject({ open: true, setupCase: "rerun", step: "github" });
  });

  it("is mounted on Settings › Account › Setup", async () => {
    renderUi(<SetupPage scope="this-mac" />, {
      fixtures: {
        ...fixtures(TWO),
        team_work_mode: { mode: "solo", chosen: true },
        settings_get: null,
        // OB-15's page reads the setup facts too.
        project_config_list: [],
        dependency_doctor: null,
      },
    });
    // OB-15's summary row says "GitHub accounts"; OB-7b's section no longer
    // does (1.176.3), so the page names each control once.
    expect(await screen.findAllByText("GitHub accounts")).toHaveLength(1);
    expect(screen.getByText("Account for each project")).toBeTruthy();
    expect(screen.getByText("Work with a team")).toBeTruthy();
  });
});

describe("the pure parts", () => {
  it("asks only with several accounts", () => {
    expect(accountChoiceNeeded(null)).toBe(false);
    expect(accountChoiceNeeded(status(null))).toBe(false);
    expect(accountChoiceNeeded(status([acct("a", { active: true })]))).toBe(false);
    expect(accountChoiceNeeded(status(TWO))).toBe(true);
  });

  it("names a signed-out account and a missing chosen one", () => {
    const options = accountOptions([acct("a", { active: true }), acct("b", { state: "refused" })], "c");
    expect(options.map((o) => o.label)).toEqual(["Active account (a)", "a", "b (signed out)", "c (not signed in)"]);
    expect(accountOptions(TWO, "WORK-ACCT").map((o) => o.value)).toEqual(["", "main-acct", "work-acct"]);
  });

  it("an HTTPS workspace's hint is its repository", () => {
    expect(workspaceHint(rows[0], TWO)).toBe("acme/lyra");
  });
});

describe("the claim chip", () => {
  const card = {
    id: "k1",
    workspaceId: "b",
    title: "T",
    ghIssueNumber: 4,
    ghAssignees: ["work-acct"],
  } as unknown as KanbanCard;

  it("is Yours for the workspace's own account while another is active", () => {
    useIdentity.setState({ githubLogin: "main-acct", githubLoginAt: Date.now() });
    useWorkspaces.setState({
      workspaces: [{ id: "b", name: "Vega", cwd: "/tmp/v", githubAccount: "work-acct" } as never],
    });
    renderUi(<CardClaimControl card={card} onClaim={() => {}} />);
    expect(screen.getByTitle("You are assigned to the backing issue")).toBeTruthy();
  });

  it("follows gh's active account when the workspace names none", () => {
    useIdentity.setState({ githubLogin: "main-acct", githubLoginAt: Date.now() });
    useWorkspaces.setState({ workspaces: [{ id: "b", name: "Vega", cwd: "/tmp/v" } as never] });
    renderUi(<CardClaimControl card={card} onClaim={() => {}} />);
    expect(screen.queryByTitle("You are assigned to the backing issue")).toBeNull();
    expect(screen.getByRole("button", { name: "Claim it too" })).toBeTruthy();
  });
});
