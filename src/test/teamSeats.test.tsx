// Launch T1–T3: a team with seats and payment, as Settings › Team and Setup ›
// Your team draw it.
//
// - T1 Create a team pays first: seats and monthly/yearly with the prices →
//   Checkout → "Waiting for the payment…" → the create form; two minutes
//   without the plan → "If you paid, your plan will appear shortly" with
//   Look again and Back; an abandoned Checkout creates nothing; after a
//   restart "Finish creating your team"; Pro and seat holders are explained.
// - T2 Members: "N of M seats", Add seats (billing), every seat taken stops
//   the add with Add seats, a seat held outside the team can be freed, and
//   Remove says the seat is free again.
// - T3 and lapse: no seat → ask the owner; another account → D10; the
//   team's plan has ended → Renew for the owner, the owner's name otherwise;
//   a repository not attached to the plan → Finish.
import { useTeamMemberStates } from "../store/teamMemberStatesStore";
import { describe, expect, it } from "vitest";
import { TeamPage } from "../components/settings/TeamPage";
import { TeamStep } from "../components/setup/TeamStep";
import type { AccountInfo, PlanGates, TeamBilling, TeamStatus, TeamView } from "../ipc";
import { useAccount } from "../store/accountStore";
import { act, renderUi, screen, waitFor, within } from "./render";
import { FREE_GATES, TEAM_GATES, setPlanGates, setTeamAllowed } from "./planGates";
import { DEFAULT_SETTINGS, useSettings } from "../store/settingsStore";
import { SETTINGS_INDEX } from "../lib/settingsIndex";

const ME: AccountInfo = {
  signedIn: true,
  login: "owner",
  sub: "1",
  plan: "free",
  teamRepo: null,
  teamRole: null,
  status: null,
  periodEnd: null,
  exp: null,
  comp: false,
  entitlementValid: true,
  lastCheckedAt: null,
  offline: false,
  lastKnownPlan: null,
  team: null,
  deviceName: "Test Mac",
};

const SIGNED_OUT: AccountInfo = { ...ME, signedIn: false, login: null, sub: null, entitlementValid: false };

const TEAM_OWNER: AccountInfo = { ...ME, plan: "team", teamRole: "owner", teamRepo: null };

function billing(stage: TeamBilling["stage"], team: TeamView | null = null): TeamBilling {
  return { stage, team, error: null };
}

function team(over: Partial<TeamView> = {}): TeamView {
  return {
    teamRepo: "owner/test-team",
    owner: { sub: "1", login: "owner" },
    seats: 3,
    assigned: [
      { sub: "1", login: "owner" },
      { sub: "2", login: "joined" },
    ],
    status: "active",
    periodEnd: null,
    ...over,
  };
}

function signIn(info: AccountInfo = ME) {
  useAccount.setState({ info, loaded: true });
}

function noTeamOnThisMac() {
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS }, loaded: true } as never);
}

/** Settings › Team › Start › Create a team (the default way) › Continue. */
async function openCreate(fixtures: Record<string, unknown>) {
  noTeamOnThisMac();
  const r = renderUi(<TeamPage scope="team" />, {
    fixtures: {
      team_status: { teamRepo: null },
      team_create_defaults: { login: "owner", workspaces: [] },
      ...fixtures,
    },
  });
  await r.user.click(await screen.findByRole("button", { name: "Start" }));
  await r.user.click(screen.getByRole("button", { name: "Continue" }));
  return r;
}

describe("T1: Create a team pays first", () => {
  it("chooses seats and monthly or yearly with the prices, then waits for the payment and shows the form", async () => {
    signIn();
    let paid = false;
    let answerWait: (v: unknown) => void = () => {};
    const { user, tauri } = await openCreate({
      team_billing_get: () => (paid ? billing({ stage: "create", comp: false }) : billing({ stage: "choose" })),
      account_checkout: () => null,
      team_checkout_wait: () => new Promise((resolve) => (answerWait = resolve)),
    });
    expect(await screen.findByText("2 seats · €18 a month, VAT included.")).toBeTruthy();
    expect(screen.getByRole("radio", { name: /Monthly · €9 per member a month/ })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "One seat more" }));
    await user.click(screen.getByRole("radio", { name: /Yearly · €86.40 per member a year/ }));
    expect(screen.getByText("3 seats · €259.20 a year, VAT included.")).toBeTruthy();
    // No repository before the payment.
    expect(screen.queryByRole("textbox", { name: "Team name" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Continue to payment" }));
    await waitFor(() => expect(tauri.callsOf("account_checkout")[0]?.args).toEqual({ plan: "team", interval: "year", seats: 3 }));
    expect(await screen.findByText("Waiting for the payment…")).toBeTruthy();
    expect(tauri.callsOf("team_create")).toHaveLength(0);

    paid = true;
    answerWait({ state: "paid", info: TEAM_OWNER });
    expect(await screen.findByText("Payment received. Now name your team.")).toBeTruthy();
    expect(await screen.findByRole("textbox", { name: "Team name" })).toBeTruthy();
  });

  it("two minutes without the plan: shortly, Look again, and Back to the choice creates nothing", async () => {
    signIn();
    const { user, tauri } = await openCreate({
      team_billing_get: billing({ stage: "choose" }),
      account_checkout: () => null,
      team_checkout_wait: { state: "pending" },
      team_checkout_wait_cancel: null,
      account_refresh: ME,
    });
    await user.click(await screen.findByRole("button", { name: "Continue to payment" }));
    expect(await screen.findByText("If you paid, your plan will appear shortly")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Look again" }));
    await waitFor(() => expect(tauri.callsOf("account_refresh")).toHaveLength(1));
    expect(await screen.findByText(/^Not yet\./)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Back to the choice" }));
    expect(await screen.findByRole("button", { name: "Continue to payment" })).toBeTruthy();
    expect(tauri.callsOf("team_checkout_wait_cancel")).toHaveLength(1);
    expect(tauri.callsOf("team_create")).toHaveLength(0);
  });

  it("Open Checkout again keeps waiting: the older wait's late answer moves nothing", async () => {
    signIn();
    const answers: Array<(v: unknown) => void> = [];
    const { user, tauri } = await openCreate({
      team_billing_get: billing({ stage: "choose" }),
      account_checkout: () => null,
      team_checkout_wait: () => new Promise((resolve) => answers.push(resolve)),
    });
    await user.click(await screen.findByRole("button", { name: "Continue to payment" }));
    await user.click(await screen.findByRole("button", { name: "Open the payment page again" }));
    await waitFor(() => expect(tauri.callsOf("team_checkout_wait")).toHaveLength(2));
    answers[0]({ state: "cancelled" });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByText("Waiting for the payment…")).toBeTruthy();
    answers[1]({ state: "pending" });
    expect(await screen.findByText("If you paid, your plan will appear shortly")).toBeTruthy();
  });

  it("Look again after a late payment moves on to the form", async () => {
    signIn();
    let paid = false;
    const { user } = await openCreate({
      team_billing_get: () => (paid ? billing({ stage: "create", comp: false }) : billing({ stage: "choose" })),
      account_checkout: () => null,
      team_checkout_wait: { state: "pending" },
      account_refresh: () => {
        paid = true;
        return TEAM_OWNER;
      },
    });
    await user.click(await screen.findByRole("button", { name: "Continue to payment" }));
    await user.click(await screen.findByRole("button", { name: "Look again" }));
    expect(await screen.findByText("Payment received. Now name your team.")).toBeTruthy();
  });

  it("after a restart a paid owner with no repository finishes creating the team, with no Checkout", async () => {
    signIn(TEAM_OWNER);
    const { tauri } = await openCreate({ team_billing_get: billing({ stage: "create", comp: false }) });
    expect(await screen.findByText("Finish creating your team")).toBeTruthy();
    expect(await screen.findByRole("textbox", { name: "Team name" })).toBeTruthy();
    expect(tauri.callsOf("account_checkout")).toHaveLength(0);
  });

  it("a comp owner goes straight to the form", async () => {
    signIn({ ...TEAM_OWNER, comp: true });
    await openCreate({ team_billing_get: billing({ stage: "create", comp: true }) });
    expect(await screen.findByText("Your plan includes a team.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Continue to payment" })).toBeNull();
  });

  it("an owner whose plan is bound sets that repository up here", async () => {
    signIn({ ...TEAM_OWNER, teamRepo: "owner/acme-team" });
    await openCreate({ team_billing_get: billing({ stage: "bound", teamRepo: "owner/acme-team" }) });
    expect(await screen.findByText("Your team is owner/acme-team.")).toBeTruthy();
    expect(((await screen.findByRole("textbox", { name: "Team repository" })) as HTMLInputElement).value).toBe(
      "owner/acme-team",
    );
  });

  it("an account whose entitlement still says pro buys Team at Checkout, like Free: no switch", async () => {
    signIn({ ...ME, plan: "pro" });
    const { tauri } = await openCreate({ team_billing_get: billing({ stage: "choose" }) });
    expect(await screen.findByRole("button", { name: "Continue to payment" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Switch to Team" })).toBeNull();
    expect(tauri.callsOf("team_switch_preview")).toHaveLength(0);
  });

  it("already subscribed at Checkout: the plan is read again, then the Portal opens", async () => {
    signIn();
    const { user, tauri } = await openCreate({
      team_billing_get: billing({ stage: "choose" }),
      account_checkout: () => {
        throw { code: "already_subscribed", message: "You already have a paid plan." };
      },
      account_refresh: ME,
      account_portal: null,
    });
    await user.click(await screen.findByRole("button", { name: "Continue to payment" }));
    expect(await screen.findByText(/One subscription per account: manage it in billing/)).toBeTruthy();
    await waitFor(() => expect(tauri.callsOf("account_refresh")).toHaveLength(1));
    await waitFor(() => expect(tauri.callsOf("account_portal")).toHaveLength(1));
    expect(tauri.callsOf("team_checkout_wait")).toHaveLength(0);
  });

  it("the seats field may be empty while typing and is set to 2–50 when left", async () => {
    signIn();
    const { user } = await openCreate({ team_billing_get: billing({ stage: "choose" }) });
    const field = (await screen.findByRole("textbox", { name: "Seats" })) as HTMLInputElement;
    await user.clear(field);
    expect(field.value).toBe("");
    await user.type(field, "75");
    await user.tab();
    expect(field.value).toBe("50");
    expect(screen.getByText("50 seats · €450 a month, VAT included.")).toBeTruthy();
    await user.clear(field);
    await user.tab();
    expect(field.value).toBe("50"); // an empty field keeps the seats it had
  });

  it("the team's plan couldn't be read: said, with Look again", async () => {
    signIn();
    let fails = true;
    const { user } = await openCreate({
      team_billing_get: () =>
        fails
          ? { stage: { stage: "choose" }, team: null, error: { code: "network", message: "Plyloft couldn't reach its server." } }
          : billing({ stage: "choose" }),
    });
    expect(await screen.findByText("Plyloft couldn't read the team's plan.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Continue to payment" })).toBeNull();
    fails = false;
    await user.click(screen.getByRole("button", { name: "Look again" }));
    expect(await screen.findByRole("button", { name: "Continue to payment" })).toBeTruthy();
  });

  it("a payment that lands after Back is still taken", async () => {
    signIn();
    let paid = false;
    let answerWait: (v: unknown) => void = () => {};
    const { user } = await openCreate({
      team_billing_get: () => (paid ? billing({ stage: "create", comp: false }) : billing({ stage: "choose" })),
      account_checkout: () => null,
      team_checkout_wait: () => new Promise((resolve) => (answerWait = resolve)),
      team_checkout_wait_cancel: null,
    });
    await user.click(await screen.findByRole("button", { name: "Continue to payment" }));
    await user.click(await screen.findByRole("button", { name: "Back" }));
    paid = true;
    answerWait({ state: "paid", info: TEAM_OWNER });
    expect(await screen.findByText("Payment received. Now name your team.")).toBeTruthy();
  });

  it("a seat on somebody's team: one team per account", async () => {
    signIn({ ...ME, plan: "team", teamRole: "member", teamRepo: "boss/team" });
    await openCreate({ team_billing_get: billing({ stage: "member", teamRepo: "boss/team" }) });
    expect(await screen.findByText("You hold a seat on boss/team.")).toBeTruthy();
  });

  it("A3 D20: signed out, Create team keeps its words, gains Sign in with GitHub, shows the code in place, then moves on to the seats", async () => {
    signIn(SIGNED_OUT);
    let signedInNow = false;
    const { user, tauri } = await openCreate({
      team_billing_get: () => (signedInNow ? billing({ stage: "choose" }) : billing({ stage: "sign_in" })),
      account_sign_in_start: { attempt: 1, userCode: "WDJB-MJHT", verificationUri: "https://github.com/login/device", expiresIn: 900 },
      account_sign_in_cancel: null,
      setup_open_page: null,
    });
    expect(await screen.findByText("Sign in to Plyloft first.")).toBeTruthy();
    expect(screen.getByText(/A team runs on the Team plan of your Plyloft account/)).toBeTruthy();
    expect(screen.queryByText("WDJB-MJHT")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Sign in with GitHub" }));
    expect(tauri.callsOf("account_sign_in_start")).toHaveLength(1);
    // The code appears in the same panel, without leaving the page.
    expect(await screen.findByText("WDJB-MJHT")).toBeTruthy();
    expect(screen.getByText("Sign in to Plyloft first.")).toBeTruthy();
    // The sign-in completes: the plan is read again and the choice shows.
    signedInNow = true;
    act(() => useAccount.setState({ info: ME, loaded: true, signIn: null, progress: null }));
    expect(await screen.findByText("2 seats · €18 a month, VAT included.")).toBeTruthy();
    expect(screen.queryByText("Sign in to Plyloft first.")).toBeNull();
  });

  it("Setup's Create path asks for the seats first too", async () => {
    signIn();
    noTeamOnThisMac();
    const { user } = renderUi(<TeamStep guided={false} githubConnected onGoGithub={() => {}} />, {
      fixtures: {
        team_status: { teamRepo: null },
        team_billing_get: billing({ stage: "choose" }),
        team_create_defaults: { login: "owner", workspaces: [] },
        // 1.176.3: Join is chosen first, so the step looks for a team at once.
        team_join_detect: { login: "owner", teams: [], scanned: 0, truncated: false, unanswered: 0, timedOut: false, problem: null },
      },
    });
    await user.click(screen.getByRole("radio", { name: /Create a team/ }));
    expect(await screen.findByText("2 seats · €18 a month, VAT included.")).toBeTruthy();
    expect(screen.queryByLabelText("Team name")).toBeNull();
  });
});

// ── With a team ──────────────────────────────────────────────────────────

function ownerStatus(over: Partial<TeamStatus> = {}): TeamStatus {
  return {
    teamRepo: "owner/test-team",
    teamName: "Test team",
    ownerLogin: "owner",
    members: [
      { login: "owner", owner: true },
      { login: "joined", owner: false },
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
  } as unknown as TeamStatus;
}

function openTeam(status: TeamStatus, fixtures: Record<string, unknown>) {
  useSettings.setState({
    settings: { ...DEFAULT_SETTINGS, team: { ...DEFAULT_SETTINGS.team, teamRepo: "owner/test-team" } },
    loaded: true,
  } as never);
  return renderUi(<TeamPage scope="team" />, {
    fixtures: {
      team_status: () => status,
      team_refresh: () => status,
      team_work_mode: { mode: "team", chosen: true },
      team_member_states: { members: [], problems: [], repos: ["owner/test-team"] },
      team_create_defaults: { login: "owner", workspaces: [] },
      team_member_ids: {
        members: [
          { sub: "1", login: "owner" },
          { sub: "2", login: "joined" },
        ],
        unresolved: [],
      },
      ...fixtures,
    },
  });
}

async function members() {
  return within((await screen.findByRole("heading", { name: "Members" })).closest("section") as HTMLElement);
}

describe("T2: seats in Members", () => {
  it("shows N of M seats and Add seats opens billing", async () => {
    signIn({ ...TEAM_OWNER, teamRepo: "owner/test-team" });
    setTeamAllowed(true);
    const { user, tauri } = openTeam(ownerStatus(), {
      team_billing_get: billing({ stage: "bound", teamRepo: "owner/test-team" }, team()),
      account_portal: null,
    });
    const section = await members();
    expect((await section.findAllByText("2 of 3 seats")).length).toBeGreaterThan(0);
    // The control's own name, the same words Settings search finds.
    expect(section.getByRole("textbox", { name: "Add somebody" })).toBeTruthy();
    const hint = section.getByText(/Add somebody takes one; Remove from team frees it\./);
    expect(SETTINGS_INDEX.find((row) => row.label === "Seats")?.hint).toBe(hint.textContent);
    await user.click(section.getByRole("button", { name: "Add seats" }));
    await waitFor(() => expect(tauri.callsOf("account_portal")).toHaveLength(1));
  });

  it("QoL 14.4 (G26): seats bought in billing show when the window comes back", async () => {
    signIn({ ...TEAM_OWNER, teamRepo: "owner/test-team" });
    setTeamAllowed(true);
    let seats = 3;
    const { user, tauri } = openTeam(ownerStatus(), {
      team_billing_get: () => billing({ stage: "bound", teamRepo: "owner/test-team" }, team({ seats })),
      account_portal: null,
    });
    const section = await members();
    expect((await section.findAllByText("2 of 3 seats")).length).toBeGreaterThan(0);
    await user.click(section.getByRole("button", { name: "Add seats" }));
    await waitFor(() => expect(tauri.callsOf("account_portal")).toHaveLength(1));
    seats = 5;
    act(() => window.dispatchEvent(new Event("focus")));
    expect((await section.findAllByText("2 of 5 seats")).length).toBeGreaterThan(0);
  });

  it("a seat taken between Review and Send: the add stops, nothing changes on GitHub, and Add seats is offered", async () => {
    signIn({ ...TEAM_OWNER, teamRepo: "owner/test-team" });
    setTeamAllowed(true);
    const { user, tauri } = openTeam(ownerStatus(), {
      team_billing_get: billing({ stage: "bound", teamRepo: "owner/test-team" }, team()),
      team_invite_plan: {
        login: "newbie",
        teamRepo: "owner/test-team",
        teamName: "Test team",
        steps: [{ repo: "owner/test-team", kind: "team_repo", permission: "push", current: "none", action: "grant" }],
        warnings: [],
        addsToManifest: true,
        digest: "d1",
      },
      // The backend still takes the seat first: somebody else took the last
      // one after Review read it free.
      team_invite_apply: () => {
        throw "All 3 seats are taken. Add seats in billing, then add newbie again. Nothing was changed on GitHub.";
      },
      account_portal: null,
    });
    const section = await members();
    await user.type(section.getByRole("textbox", { name: "Add somebody" }), "newbie");
    await user.click(section.getByRole("button", { name: "Review" }));
    const localReads = tauri.callsOf("team_status").length;
    await user.click(await screen.findByRole("button", { name: "Send invites" }));
    expect(await section.findByText(/All 3 seats are taken\./)).toBeTruthy();
    expect(tauri.callsOf("team_status")).toHaveLength(localReads);
    const addSeats = section.getAllByRole("button", { name: "Add seats" });
    await user.click(addSeats[addSeats.length - 1]);
    await waitFor(() => expect(tauri.callsOf("account_portal")).toHaveLength(1));
  });

  it("N14 F7: every seat taken — Review says so with Add seats, shows no plan, and goes on once a seat is added", async () => {
    signIn({ ...TEAM_OWNER, teamRepo: "owner/test-team" });
    setTeamAllowed(true);
    let seats = 2;
    const { user, tauri } = openTeam(ownerStatus(), {
      team_billing_get: () => billing({ stage: "bound", teamRepo: "owner/test-team" }, team({ seats })),
      team_invite_plan: {
        login: "newbie",
        teamRepo: "owner/test-team",
        teamName: "Test team",
        steps: [{ repo: "owner/test-team", kind: "team_repo", permission: "push", current: "none", action: "grant" }],
        warnings: [],
        addsToManifest: true,
        digest: "d1",
      },
      account_portal: null,
    });
    const section = await members();
    expect((await section.findAllByText("2 of 2 seats")).length).toBeGreaterThan(0);
    await user.type(section.getByRole("textbox", { name: "Add somebody" }), "newbie");
    const readsBefore = tauri.callsOf("team_billing_get").length;
    await user.click(section.getByRole("button", { name: "Review" }));
    // Entering the no-seat Review reads the seats again at once.
    await waitFor(() => expect(tauri.callsOf("team_billing_get").length).toBeGreaterThan(readsBefore));
    const flow = within((await screen.findByRole("heading", { name: /Add newbie to/ })).closest(".ux-flow") as HTMLElement);
    expect(flow.getByText("All 2 seats are taken.")).toBeTruthy();
    expect(flow.queryByRole("button", { name: "Send invites" })).toBeNull();
    expect(flow.queryByText("no GitHub account with this name")).toBeNull();
    await user.click(flow.getByRole("button", { name: "Add seats" }));
    await waitFor(() => expect(tauri.callsOf("account_portal")).toHaveLength(1));
    // Back from billing with a seat added: focus reads the seats again, and
    // the plan follows for the same login.
    seats = 3;
    window.dispatchEvent(new Event("focus"));
    expect(await screen.findByRole("button", { name: "Send invites" })).toBeTruthy();
    expect(tauri.callsOf("team_invite_plan")[0]?.args).toEqual({ login: "newbie" });
    // Focus was on the no-seat flow's Add seats: the plan's heading takes it.
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("heading", { name: /Add newbie to/ })),
    );
    expect(screen.queryByText("All 2 seats are taken.")).toBeNull();
  });

  describe("Every seat taken, and a login GitHub has to answer for", () => {
    const WORDS = "GitHub has no account named ghost-login. Check the spelling; Plyloft sends nothing.";
    const planWith = (action: string) => ({
      login: "ghost-login",
      teamRepo: "owner/test-team",
      teamName: "Test team",
      steps: [
        { repo: "owner/test-team", kind: "team_repo", permission: "push", current: action === "grant" ? "none" : "no account", action, purpose: "" },
      ],
      warnings: [],
      addsToManifest: true,
      digest: "",
    });

    async function reviewGhost(plan: unknown) {
      signIn({ ...TEAM_OWNER, teamRepo: "owner/test-team" });
      setTeamAllowed(true);
      const opened = openTeam(ownerStatus(), {
        team_billing_get: () => billing({ stage: "bound", teamRepo: "owner/test-team" }, team({ seats: 2 })),
        team_invite_plan: plan,
        account_portal: null,
      });
      const section = await members();
      expect((await section.findAllByText("2 of 2 seats")).length).toBeGreaterThan(0);
      const field = section.getByRole("textbox", { name: "Add somebody" }) as HTMLInputElement;
      await opened.user.type(field, "ghost-login");
      await opened.user.click(section.getByRole("button", { name: "Review" }));
      return { ...opened, section, field };
    }

    it("no such account: the refusal, with Send off and no seat to buy", async () => {
      const { user, tauri, field, section } = await reviewGhost(planWith("no_such_account"));
      expect(await screen.findByText(WORDS)).toBeTruthy();
      expect(screen.getByText("no GitHub account with this name")).toBeTruthy();
      expect((screen.getByRole("button", { name: "Send invites" }) as HTMLButtonElement).disabled).toBe(true);
      expect(screen.queryByText("All 2 seats are taken.")).toBeNull();
      expect(document.querySelector("[data-ply-no-seat]")).toBeNull();
      expect(screen.queryByText("This takes one seat.")).toBeNull();
      // Only the Seats row's own Add seats is left on the page.
      expect(section.getAllByRole("button", { name: "Add seats" })).toHaveLength(1);
      expect(tauri.callsOf("team_invite_apply")).toHaveLength(0);
      await user.click(screen.getByRole("button", { name: "Cancel" }));
      expect(screen.queryByText(WORDS)).toBeNull();
      expect(field.value).toBe("ghost-login");
    });

    it("a real login still gets the no-seat sheet", async () => {
      await reviewGhost(planWith("grant"));
      expect(await screen.findByText("All 2 seats are taken.")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Send invites" })).toBeNull();
      expect(screen.queryByText(WORDS)).toBeNull();
    });

    it("GitHub didn't answer for the login: the no-seat sheet, and no claim about the account", async () => {
      await reviewGhost(planWith("unresolved"));
      expect(await screen.findByText("All 2 seats are taken.")).toBeTruthy();
      expect(screen.queryByText(/no account named/)).toBeNull();
      expect(screen.queryByRole("button", { name: "Send invites" })).toBeNull();
    });

    it("the plan couldn't be read at all: the no-seat sheet, and no toast about grants", async () => {
      await reviewGhost(() => {
        throw "gh: could not connect";
      });
      expect(await screen.findByText("All 2 seats are taken.")).toBeTruthy();
      expect(screen.queryByText(/no account named/)).toBeNull();
      expect(screen.queryByText("Couldn't work out what to grant")).toBeNull();
    });

    it("an answer that comes after a newer Review changes nothing", async () => {
      signIn({ ...TEAM_OWNER, teamRepo: "owner/test-team" });
      setTeamAllowed(true);
      const answers: Record<string, (plan: unknown) => void> = {};
      const { user } = openTeam(ownerStatus(), {
        team_billing_get: () => billing({ stage: "bound", teamRepo: "owner/test-team" }, team({ seats: 2 })),
        team_invite_plan: ({ login }: { login: string }) => new Promise((resolve) => (answers[login] = resolve)),
      });
      const section = await members();
      expect((await section.findAllByText("2 of 2 seats")).length).toBeGreaterThan(0);
      const field = section.getByRole("textbox", { name: "Add somebody" });
      await user.type(field, "first{Enter}");
      await user.clear(field);
      await user.type(field, "second{Enter}");
      await waitFor(() => expect(answers.second).toBeTruthy());
      answers.second({ ...planWith("no_such_account"), login: "second" });
      await screen.findByText("GitHub has no account named second. Check the spelling; Plyloft sends nothing.");
      answers.first({ ...planWith("grant"), login: "first" });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(screen.getByText("GitHub has no account named second. Check the spelling; Plyloft sends nothing.")).toBeTruthy();
      expect(screen.queryByText("All 2 seats are taken.")).toBeNull();
    });
  });

  it("N14 F7: a plan that follows a freed seat leaves focus where the owner put it", async () => {
    signIn({ ...TEAM_OWNER, teamRepo: "owner/test-team" });
    setTeamAllowed(true);
    let seats = 2;
    const { user } = openTeam(ownerStatus(), {
      team_billing_get: () => billing({ stage: "bound", teamRepo: "owner/test-team" }, team({ seats })),
      team_invite_plan: {
        login: "newbie",
        teamRepo: "owner/test-team",
        teamName: "Test team",
        steps: [{ repo: "owner/test-team", kind: "team_repo", permission: "push", current: "none", action: "grant" }],
        warnings: [],
        addsToManifest: true,
        digest: "d1",
      },
    });
    const section = await members();
    expect((await section.findAllByText("2 of 2 seats")).length).toBeGreaterThan(0);
    const field = section.getByRole("textbox", { name: "Add somebody" });
    await user.type(field, "newbie");
    await user.click(section.getByRole("button", { name: "Review" }));
    await screen.findByText("All 2 seats are taken.");
    field.focus();
    seats = 3;
    const scrolls: { el: Element; options: unknown }[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element, options?: unknown) {
      scrolls.push({ el: this, options });
    } as typeof Element.prototype.scrollIntoView;
    try {
      window.dispatchEvent(new Event("focus"));
      const send = await screen.findByRole("button", { name: "Send invites" });
      expect(document.activeElement).toBe(field);
      // It only has to be seen: `start` would scroll away what's being read.
      const flow = send.closest(".ux-flow");
      await waitFor(() => expect(scrolls.some((s) => s.el === flow)).toBe(true));
      expect(scrolls.filter((s) => s.el === flow).every((s) => (s.options as ScrollIntoViewOptions).block === "nearest")).toBe(true);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it("N14 F7: Look again reads the seats; still full, Review stays; a seated member's Review access is never stopped", async () => {
    signIn({ ...TEAM_OWNER, teamRepo: "owner/test-team" });
    setTeamAllowed(true);
    const { user, tauri } = openTeam(ownerStatus(), {
      team_billing_get: billing({ stage: "bound", teamRepo: "owner/test-team" }, team({ seats: 2 })),
      team_invite_plan: (args: { login: string }) => ({
        login: args.login,
        teamRepo: "owner/test-team",
        teamName: "Test team",
        steps: [{ repo: "owner/test-team", kind: "team_repo", permission: "push", current: "push", action: "none" }],
        warnings: [],
        addsToManifest: false,
        digest: "d1",
      }),
      account_portal: null,
    });
    const section = await members();
    expect((await section.findAllByText("2 of 2 seats")).length).toBeGreaterThan(0);
    await user.type(section.getByRole("textbox", { name: "Add somebody" }), "newbie");
    await user.click(section.getByRole("button", { name: "Review" }));
    await screen.findByText("All 2 seats are taken.");
    const reads = tauri.callsOf("team_billing_get").length;
    await user.click(screen.getByRole("button", { name: "Look again" }));
    await waitFor(() => expect(tauri.callsOf("team_billing_get").length).toBeGreaterThan(reads));
    expect(screen.getByText("All 2 seats are taken.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("All 2 seats are taken.")).toBeNull();
    // "joined" holds a seat: Review access reads the plan though no seat is free.
    const joined = section.getByText("joined").closest(".ux-row") as HTMLElement;
    await user.click(within(joined).getByRole("button", { name: "Review access" }));
    await waitFor(() => expect(tauri.callsOf("team_invite_plan").slice(-1)[0]?.args).toEqual({ login: "joined" }));
    expect(screen.queryByText("All 2 seats are taken.")).toBeNull();
  });

  it("a renamed member is matched by id; a listed member with no seat can be given one", async () => {
    signIn({ ...TEAM_OWNER, teamRepo: "owner/test-team" });
    setTeamAllowed(true);
    const { user, tauri } = openTeam(
      ownerStatus({
        members: [
          { login: "owner", owner: true },
          { login: "joined", owner: false },
          { login: "early", owner: false },
        ],
      } as Partial<TeamStatus>),
      {
        // The server still knows "joined" by an older login: same id, no stray.
        team_billing_get: billing(
          { stage: "bound", teamRepo: "owner/test-team" },
          team({ assigned: [{ sub: "1", login: "owner" }, { sub: "2", login: "old-name" }] }),
        ),
        team_member_ids: {
          members: [
            { sub: "1", login: "owner" },
            { sub: "2", login: "joined" },
            { sub: "5", login: "early" },
          ],
          unresolved: [],
        },
        team_seat_give: null,
      },
    );
    const section = await members();
    expect(await section.findByText("No seat")).toBeTruthy();
    expect(section.queryByText("seat only")).toBeNull();
    expect(section.getByText("They have no seat on the team's plan yet. Give them one.")).toBeTruthy();
    // N14 F2: Give a seat is the row's own button while the member has none;
    // Review access waits in ⋯ meanwhile, and a seated member keeps it.
    const early = section.getByText("early").closest(".ux-row") as HTMLElement;
    expect(within(early).queryByRole("button", { name: "Review access" })).toBeNull();
    const joined = section.getByText("joined").closest(".ux-row") as HTMLElement;
    expect(within(joined).getByRole("button", { name: "Review access" })).toBeTruthy();
    expect(within(joined).queryByRole("button", { name: "Give a seat" })).toBeNull();
    await user.click(section.getByRole("button", { name: "More for early" }));
    expect(await screen.findByRole("menuitem", { name: "Review access" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Give a seat" })).toBeNull();
    await user.keyboard("{Escape}");
    await user.click(within(early).getByRole("button", { name: "Give a seat" }));
    await waitFor(() => expect(tauri.callsOf("team_seat_give")[0]?.args).toEqual({ login: "early" }));
  });

  it("1.174.3: a Remove left half-finished: its seat is free, and the row offers Remove, not Give a seat", async () => {
    signIn({ ...TEAM_OWNER, teamRepo: "owner/test-team" });
    setTeamAllowed(true);
    useTeamMemberStates.getState().noteRemoval("owner/test-team", "early", true);
    const { user } = openTeam(
      ownerStatus({
        members: [
          { login: "owner", owner: true },
          { login: "early", owner: false },
        ],
      } as Partial<TeamStatus>),
      {
        team_billing_get: billing(
          { stage: "bound", teamRepo: "owner/test-team" },
          team({ assigned: [{ sub: "1", login: "owner" }] }),
        ),
        team_member_ids: {
          members: [
            { sub: "1", login: "owner" },
            { sub: "5", login: "early" },
          ],
          unresolved: [],
        },
        team_member_states: {
          members: [
            { login: "owner", owner: true, state: "joined", invitationExpires: null, invitationExpired: null, workspacesInvited: [], workspacesMissing: [] },
            { login: "early", owner: false, state: "no_access", invitationExpires: null, invitationExpired: null, workspacesInvited: [], workspacesMissing: [] },
          ],
          problems: [],
          repos: ["owner/test-team"],
        },
      },
    );
    const section = await members();
    expect(await section.findByText("No seat")).toBeTruthy();
    const early = within(section.getByText("early").closest(".ux-row") as HTMLElement);
    expect(early.getByText("Their access is gone, but the team still lists them. Remove from team again to finish.")).toBeTruthy();
    expect(early.getByText("No access")).toBeTruthy();
    expect(early.queryByRole("button", { name: "Give a seat" })).toBeNull();
    expect(early.getByRole("button", { name: "Remove from team…" })).toBeTruthy();
    await user.click(section.getByRole("button", { name: "More for early" }));
    expect(await screen.findByRole("menuitem", { name: "Review access" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Remove from team…" })).toBeNull();
  });

  it("a comp team has no Add seats, and Review with every seat taken says Plyloft sets the seats", async () => {
    signIn({ ...TEAM_OWNER, teamRepo: "owner/test-team", comp: true });
    setTeamAllowed(true);
    const { user } = openTeam(ownerStatus(), {
      team_billing_get: billing({ stage: "bound", teamRepo: "owner/test-team" }, team({ seats: 2 })),
      team_invite_plan: {
        login: "newbie",
        teamRepo: "owner/test-team",
        teamName: "Test team",
        steps: [{ repo: "owner/test-team", kind: "team_repo", permission: "push", current: "none", action: "grant" }],
        warnings: [],
        addsToManifest: true,
        digest: "d1",
      },
    });
    const section = await members();
    expect((await section.findAllByText("2 of 2 seats")).length).toBeGreaterThan(0);
    expect(section.queryByRole("button", { name: "Add seats" })).toBeNull();
    await user.type(section.getByRole("textbox", { name: "Add somebody" }), "newbie");
    await user.click(section.getByRole("button", { name: "Review" }));
    expect(await section.findByText("All 2 seats are taken.")).toBeTruthy();
    expect(section.getByText(/set by Plyloft/)).toBeTruthy();
    expect(section.queryByRole("button", { name: "Add seats" })).toBeNull();
    expect(section.queryByRole("button", { name: "Send invites" })).toBeNull();
  });

  it("another team's seats are never shown on this Mac's team", async () => {
    signIn({ ...TEAM_OWNER, teamRepo: "owner/test-team" });
    setTeamAllowed(true);
    openTeam(ownerStatus(), {
      team_billing_get: billing({ stage: "bound", teamRepo: "owner/test-team" }, team({ teamRepo: "owner/other-team" })),
    });
    const section = await members();
    await waitFor(() => expect(section.getByText("Add somebody")).toBeTruthy());
    expect(section.queryByText(/of 3 seats/)).toBeNull();
  });

  it("a member GitHub couldn't look up: no seat is called outside the team, and who is named", async () => {
    signIn({ ...TEAM_OWNER, teamRepo: "owner/test-team" });
    setTeamAllowed(true);
    openTeam(ownerStatus(), {
      team_billing_get: billing(
        { stage: "bound", teamRepo: "owner/test-team" },
        team({ assigned: [{ sub: "1", login: "owner" }, { sub: "2", login: "joined" }, { sub: "9", login: "gone" }] }),
      ),
      team_member_ids: { members: [{ sub: "1", login: "owner" }], unresolved: ["joined"] },
    });
    const section = await members();
    expect(await section.findByText(/Couldn't look up joined on GitHub/)).toBeTruthy();
    expect(section.queryByText("seat only")).toBeNull();
    expect(section.queryByRole("button", { name: "Free the seat" })).toBeNull();
  });

  it("a seat held outside the team can be freed", async () => {
    signIn({ ...TEAM_OWNER, teamRepo: "owner/test-team" });
    setTeamAllowed(true);
    const { user, tauri } = openTeam(ownerStatus(), {
      team_billing_get: billing(
        { stage: "bound", teamRepo: "owner/test-team" },
        team({ assigned: [{ sub: "1", login: "owner" }, { sub: "2", login: "joined" }, { sub: "9", login: "gone" }] }),
      ),
      team_seat_free: null,
    });
    const section = await members();
    expect(await section.findByText("seat only")).toBeTruthy();
    await user.click(section.getByRole("button", { name: "Free the seat" }));
    await waitFor(() => expect(tauri.callsOf("team_seat_free")[0]?.args).toEqual({ sub: "9" }));
  });

  describe("seats said beforehand", () => {
    const FREES = "Their seat on the team's plan goes free.";
    const TAKES = "This takes one seat.";
    const plan = (over: Record<string, unknown> = {}) => ({
      login: "newbie",
      teamName: "Test team",
      digest: "d1",
      addsToManifest: true,
      warnings: [],
      steps: [{ repo: "owner/test-team", kind: "team_repo", permission: "push", current: "none", action: "grant", purpose: "" }],
      ...over,
    });
    const seats = (over: Record<string, unknown> = {}) =>
      billing({ stage: "bound", teamRepo: "owner/test-team" }, team(over));
    async function openRemoveSheet(user: ReturnType<typeof openTeam>["user"], section: Awaited<ReturnType<typeof members>>) {
      await user.click(await section.findByRole("button", { name: "More for joined" }));
      await user.click(await screen.findByRole("menuitem", { name: "Remove from team…" }));
      return within(await screen.findByRole("dialog"));
    }
    async function reviewNewbie(user: ReturnType<typeof openTeam>["user"], section: Awaited<ReturnType<typeof members>>) {
      await user.type(section.getByRole("textbox", { name: "Add somebody" }), "newbie");
      await user.click(section.getByRole("button", { name: "Review" }));
      await screen.findByRole("heading", { name: "Add newbie to Test team" });
    }

    it("with seats on the server, the Remove sheet and the plan say so", async () => {
      signIn({ ...TEAM_OWNER, teamRepo: "owner/test-team" });
      setTeamAllowed(true);
      const { user } = openTeam(ownerStatus(), {
        team_billing_get: seats({ assigned: [{ sub: "1", login: "owner" }, { sub: "2", login: "joined" }] }),
        team_invite_plan: plan(),
      });
      const section = await members();
      await section.findAllByText("2 of 3 seats");
      const sheet = await openRemoveSheet(user, section);
      expect(await sheet.findByText(FREES)).toBeTruthy();
      await user.click(sheet.getByRole("button", { name: "Cancel" }));
      await reviewNewbie(user, section);
      expect(await section.findByText(TAKES)).toBeTruthy();
    });

    it("a renamed holder, matched by id: the sheet frees and Review access takes no other", async () => {
      signIn({ ...TEAM_OWNER, teamRepo: "owner/test-team" });
      setTeamAllowed(true);
      const { user } = openTeam(ownerStatus(), {
        // The server still has the login from before the rename.
        team_billing_get: seats({ assigned: [{ sub: "1", login: "owner" }, { sub: "2", login: "joined-old" }] }),
        team_invite_plan: plan({ login: "joined", addsToManifest: false }),
      });
      const section = await members();
      await section.findAllByText("2 of 3 seats");
      const sheet = await openRemoveSheet(user, section);
      expect(await sheet.findByText(FREES)).toBeTruthy();
      await user.click(sheet.getByRole("button", { name: "Cancel" }));
      const joined = section.getByText("joined").closest(".ux-row") as HTMLElement;
      await user.click(within(joined).getByRole("button", { name: "Review access" }));
      await screen.findByRole("heading", { name: "Add joined to Test team" });
      expect(section.queryByText(TAKES)).toBeNull();
    });

    for (const [why, idsFixture] of [
      ["failed", () => { throw new Error("no"); }],
      ["named them unresolved", () => ({ members: [{ sub: "1", login: "owner" }], unresolved: ["joined"] })],
      ["not landed yet", () => new Promise(() => {})],
    ] as const) {
      it(`the ids ${why}: neither line, where the login would be the only evidence`, async () => {
        signIn({ ...TEAM_OWNER, teamRepo: "owner/test-team" });
        setTeamAllowed(true);
        const { user } = openTeam(ownerStatus(), {
          team_billing_get: seats({ assigned: [{ sub: "1", login: "owner" }, { sub: "2", login: "joined-old" }] }),
          team_member_ids: idsFixture,
          team_invite_plan: plan({ login: "joined", addsToManifest: false }),
        });
        const section = await members();
        await section.findAllByText("2 of 3 seats");
        const sheet = await openRemoveSheet(user, section);
        await sheet.findByText(/it takes them off their issues/);
        expect(sheet.queryByText(FREES)).toBeNull();
        await user.click(sheet.getByRole("button", { name: "Cancel" }));
        const joined = section.getByText("joined").closest(".ux-row") as HTMLElement;
        await user.click(within(joined).getByRole("button", { name: "Review access" }));
        await screen.findByRole("heading", { name: "Add joined to Test team" });
        expect(section.queryByText(TAKES)).toBeNull();
      });
    }

    it("a comp team's seats count the same, so it says so too", async () => {
      signIn({ ...TEAM_OWNER, comp: true, teamRepo: "owner/test-team" });
      setTeamAllowed(true);
      const { user } = openTeam(ownerStatus(), {
        team_billing_get: seats({ assigned: [{ sub: "1", login: "owner" }, { sub: "2", login: "joined" }] }),
        team_invite_plan: plan(),
      });
      const section = await members();
      await section.findAllByText("2 of 3 seats");
      const sheet = await openRemoveSheet(user, section);
      expect(await sheet.findByText(FREES)).toBeTruthy();
      await user.click(sheet.getByRole("button", { name: "Cancel" }));
      await reviewNewbie(user, section);
      expect(await section.findByText(TAKES)).toBeTruthy();
    });

    it("no seats on the server (a dev plan, a read that failed): neither line", async () => {
      signIn({ ...TEAM_OWNER, teamRepo: "owner/test-team" });
      setTeamAllowed(true);
      const { user } = openTeam(ownerStatus(), {
        team_billing_get: billing({ stage: "bound", teamRepo: "owner/test-team" }),
        team_invite_plan: plan(),
      });
      const section = await members();
      const sheet = await openRemoveSheet(user, section);
      expect(sheet.getByText(/it takes them off their issues/)).toBeTruthy();
      expect(sheet.queryByText(FREES)).toBeNull();
      await user.click(sheet.getByRole("button", { name: "Cancel" }));
      await reviewNewbie(user, section);
      expect(section.queryByText(TAKES)).toBeNull();
    });

    it("a member who holds no seat frees none; one who holds a seat takes no other", async () => {
      signIn({ ...TEAM_OWNER, teamRepo: "owner/test-team" });
      setTeamAllowed(true);
      const { user } = openTeam(ownerStatus(), {
        team_billing_get: seats({ assigned: [{ sub: "1", login: "owner" }] }),
        team_invite_plan: plan({ login: "owner", addsToManifest: false }),
      });
      const section = await members();
      await section.findAllByText("1 of 3 seats");
      await section.findByText("No seat");
      const sheet = await openRemoveSheet(user, section);
      expect(sheet.queryByText(FREES)).toBeNull();
      await user.click(sheet.getByRole("button", { name: "Cancel" }));
      await user.click(section.getAllByRole("button", { name: "Review access" })[0]);
      await screen.findByRole("heading", { name: "Add owner to Test team" });
      expect(section.queryByText(TAKES)).toBeNull();
    });

    it("a plan that can't be sent takes nothing, so it says nothing", async () => {
      signIn({ ...TEAM_OWNER, teamRepo: "owner/test-team" });
      setTeamAllowed(true);
      const { user } = openTeam(ownerStatus(), {
        team_billing_get: seats(),
        team_invite_plan: plan({
          steps: [{ repo: "owner/test-team", kind: "team_repo", permission: "push", current: "none", action: "no_such_account", purpose: "" }],
        }),
      });
      const section = await members();
      await section.findAllByText("2 of 3 seats");
      await reviewNewbie(user, section);
      expect(section.queryByText(TAKES)).toBeNull();
    });
  });

  it("All N seats are taken goes when a seat is pressed free: Remove from team and Free the seat", async () => {
    signIn({ ...TEAM_OWNER, teamRepo: "owner/test-team" });
    setTeamAllowed(true);
    const LIMIT = /All 3 seats are taken\./;
    const { user } = openTeam(ownerStatus(), {
      team_billing_get: billing(
        { stage: "bound", teamRepo: "owner/test-team" },
        team({ assigned: [{ sub: "1", login: "owner" }, { sub: "2", login: "joined" }, { sub: "9", login: "gone" }] }),
      ),
      team_invite_plan: {
        login: "newbie",
        teamName: "Test team",
        digest: "d1",
        addsToManifest: true,
        warnings: [],
        steps: [{ repo: "owner/test-team", kind: "team_repo", permission: "push", current: "none", action: "grant", purpose: "" }],
      },
      team_invite_apply: () => {
        throw "All 3 seats are taken. Add seats in billing, then add newbie again. Nothing was changed on GitHub.";
      },
      team_seat_free: null,
      team_member_remove: {
        login: "joined",
        removed: ["owner/test-team"],
        cancelledInvitations: [],
        stillRead: [],
        failed: [],
        manifestUpdated: true,
        manifestError: null,
        seatFreed: true,
        seatError: null,
      },
    });
    const section = await members();
    await section.findByText("seat only");
    const refused = async () => {
      await user.clear(section.getByRole("textbox", { name: "Add somebody" }));
      await user.type(section.getByRole("textbox", { name: "Add somebody" }), "gone");
      await user.click(section.getByRole("button", { name: "Review" }));
      await user.click(await screen.findByRole("button", { name: "Send invites" }));
      await section.findByText(LIMIT);
    };
    await refused();
    await user.click(section.getByRole("button", { name: "Free the seat" }));
    await waitFor(() => expect(section.queryByText(LIMIT)).toBeNull());
    await refused();
    await user.click(section.getByRole("button", { name: "More for joined" }));
    await user.click(await screen.findByRole("menuitem", { name: "Remove from team…" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Remove from team" }));
    await waitFor(() => expect(section.queryByText(LIMIT)).toBeNull());
  });

  it("a plan that follows the seat a Remove freed keeps that Remove's result on screen", async () => {
    signIn({ ...TEAM_OWNER, teamRepo: "owner/test-team" });
    setTeamAllowed(true);
    let assigned = [{ sub: "1", login: "owner" }, { sub: "2", login: "joined" }];
    const { user } = openTeam(ownerStatus(), {
      team_billing_get: () => billing({ stage: "bound", teamRepo: "owner/test-team" }, team({ seats: 2, assigned })),
      team_invite_plan: {
        login: "newbie",
        teamName: "Test team",
        digest: "d1",
        addsToManifest: true,
        warnings: [],
        steps: [{ repo: "owner/test-team", kind: "team_repo", permission: "push", current: "none", action: "grant", purpose: "" }],
      },
      team_member_remove: () => {
        assigned = [{ sub: "1", login: "owner" }];
        return {
          login: "joined",
          removed: ["owner/test-team"],
          cancelledInvitations: [],
          stillRead: [],
          failed: [],
          manifestUpdated: true,
          manifestError: null,
          seatFreed: true,
          seatError: null,
        };
      },
    });
    const section = await members();
    await section.findAllByText("2 of 2 seats");
    await user.type(section.getByRole("textbox", { name: "Add somebody" }), "newbie");
    await user.click(section.getByRole("button", { name: "Review" }));
    await section.findByText("All 2 seats are taken.");
    await user.click(section.getByRole("button", { name: "More for joined" }));
    await user.click(await screen.findByRole("menuitem", { name: "Remove from team…" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Remove from team" }));
    expect(await screen.findByRole("heading", { name: "Add newbie to Test team" })).toBeTruthy();
    expect(section.getByText(/Their seat on the team's plan is free again\./)).toBeTruthy();
  });

  it("Remove from team says the seat is free again, or that it is still taken", async () => {
    signIn({ ...TEAM_OWNER, teamRepo: "owner/test-team" });
    setTeamAllowed(true);
    let seatError: string | null = null;
    const { user } = openTeam(ownerStatus(), {
      team_billing_get: billing({ stage: "bound", teamRepo: "owner/test-team" }, team()),
      team_member_remove: () => ({
        login: "joined",
        removed: ["owner/test-team"],
        cancelledInvitations: [],
        stillRead: [],
        failed: [],
        manifestUpdated: true,
        manifestError: null,
        seatFreed: seatError === null,
        seatError,
      }),
    });
    const section = await members();
    const remove = async () => {
      await user.click(section.getByRole("button", { name: "More for joined" }));
      await user.click(await screen.findByRole("menuitem", { name: "Remove from team…" }));
      const sheet = await screen.findByRole("dialog");
      await user.click(within(sheet).getByRole("button", { name: "Remove from team" }));
    };
    await remove();
    expect(await section.findByText(/Their seat on the team's plan is free again\./)).toBeTruthy();
    seatError = "joined is out of the team on GitHub, but their seat is still taken (offline). Free it from Members.";
    await remove();
    expect(await section.findByText(/their seat is still taken \(offline\)/)).toBeTruthy();
  });
});

// U23 (N14 T2.15): `team_billing::add_member_with_seat` says "add them again to
// retry, or press Free the seat (Remove from team… if they're listed)". Each
// state its failure can leave, and the press those words lead to there.
describe("U23: a seat with no manifest line, and the words that lead to it", () => {
  const WORDS =
    "newbie holds a seat on the team's plan: add them again to retry, or press Free the seat (Remove from team… if they're listed).";
  const plan = {
    login: "newbie",
    teamName: "Test team",
    digest: "o/t=push",
    addsToManifest: true,
    warnings: [],
    steps: [{ repo: "owner/test-team", kind: "team_repo", permission: "push", current: "none", action: "grant", purpose: "" }],
  };
  const NEWBIE = { sub: "7", login: "newbie" };
  const OWNER_SEAT = { sub: "1", login: "owner" };
  const JOINED_SEAT = { sub: "2", login: "joined" };
  const ids = (...more: { sub: string; login: string }[]) => ({ members: [OWNER_SEAT, JOINED_SEAT, ...more], unresolved: [] });
  const listed = () =>
    ownerStatus({
      members: [
        { login: "owner", owner: true },
        { login: "joined", owner: false },
        { login: "newbie", owner: false },
      ],
    } as Partial<TeamStatus>);

  /** The server's seats, which each fixture reads and changes. */
  function seats(initial: { sub: string; login: string }[]) {
    let assigned = initial;
    return {
      read: () => billing({ stage: "bound", teamRepo: "owner/test-team" }, team({ seats: 5, assigned })),
      take: () => (assigned = assigned.some((a) => a.sub === NEWBIE.sub) ? assigned : [...assigned, NEWBIE]),
      free: (sub: string) => (assigned = assigned.filter((a) => a.sub !== sub)),
    };
  }
  const row = (section: Awaited<ReturnType<typeof members>>, login: string) =>
    section.getByText(login).closest(".ux-row") as HTMLElement;
  function signedIn() {
    signIn({ ...TEAM_OWNER, teamRepo: "owner/test-team" });
    setTeamAllowed(true);
  }
  async function failedSend(user: ReturnType<typeof openTeam>["user"], section: Awaited<ReturnType<typeof members>>) {
    await user.type(section.getByRole("textbox", { name: "Add somebody" }), "newbie");
    await user.click(section.getByRole("button", { name: "Review" }));
    await user.click(await screen.findByRole("button", { name: "Send invites" }));
    return (await section.findByRole("alert")).textContent ?? "";
  }

  it("held with no manifest line: the seat only row and Free the seat, which frees it and goes", async () => {
    signedIn();
    const server = seats([OWNER_SEAT, JOINED_SEAT, NEWBIE]);
    const { user, tauri } = openTeam(ownerStatus(), {
      team_billing_get: server.read,
      team_seat_free: ({ sub }: { sub: string }) => {
        server.free(sub);
        return null;
      },
    });
    const section = await members();
    expect(await section.findByText("seat only")).toBeTruthy();
    const line = within(row(section, "newbie"));
    expect(line.getByText(/Holds a seat but isn't in the team/)).toBeTruthy();
    await user.click(line.getByRole("button", { name: "Free the seat" }));
    await waitFor(() => expect(tauri.callsOf("team_seat_free")[0]?.args).toEqual({ sub: "7" }));
    await waitFor(() => expect(section.queryByText("seat only")).toBeNull());
    expect(section.queryByText("newbie")).toBeNull();
  });

  it("an add that stopped before the manifest: its words, then Free the seat and Send again are both real presses", async () => {
    signedIn();
    const server = seats([OWNER_SEAT, JOINED_SEAT]);
    let tries = 0;
    const { user, tauri } = openTeam(ownerStatus(), {
      team_billing_get: server.read,
      team_invite_plan: plan,
      team_invite_apply: () => {
        tries += 1;
        server.take();
        throw new Error(`Could not pull the team repo. ${WORDS}`);
      },
      team_seat_free: ({ sub }: { sub: string }) => {
        server.free(sub);
        return null;
      },
    });
    const section = await members();
    await section.findAllByText("2 of 5 seats");
    expect(await failedSend(user, section)).toContain(`Couldn't add the member. Could not pull the team repo. ${WORDS}`);
    // "add them again to retry": the plan is still there, and its Send goes.
    const send = screen.getByRole("button", { name: "Send invites" }) as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    expect(await section.findByText("seat only")).toBeTruthy();
    await user.click(send);
    await waitFor(() => expect(tries).toBe(2));
    // "press Free the seat": the row is there, above the plan.
    await user.click(within(row(section, "newbie")).getByRole("button", { name: "Free the seat" }));
    await waitFor(() => expect(tauri.callsOf("team_seat_free")[0]?.args).toEqual({ sub: "7" }));
  });

  it("an add that stopped after the manifest, once the page has read it: Remove from team…, and no Free the seat", async () => {
    signedIn();
    const server = seats([OWNER_SEAT, JOINED_SEAT, NEWBIE]);
    const { user } = openTeam(listed(), {
      team_billing_get: server.read,
      team_member_ids: ids(NEWBIE),
      team_member_remove: {
        login: "newbie",
        removed: ["owner/test-team"],
        cancelledInvitations: [],
        stillRead: [],
        failed: [],
        manifestUpdated: true,
        manifestError: null,
        seatFreed: true,
        seatError: null,
      },
    });
    const section = await members();
    await section.findAllByText("3 of 5 seats");
    expect(section.queryByRole("button", { name: "Free the seat" })).toBeNull();
    await user.click(await section.findByRole("button", { name: "More for newbie" }));
    await user.click(await screen.findByRole("menuitem", { name: "Remove from team…" }));
    const sheet = within(await screen.findByRole("dialog"));
    await user.click(sheet.getByRole("button", { name: "Remove from team" }));
    expect(await section.findByText(/Their seat on the team's plan is free again\./)).toBeTruthy();
  });

  it("a Remove whose seat stayed: \"Free it from Members\" finds the row once the member is off the list", async () => {
    signedIn();
    const server = seats([OWNER_SEAT, JOINED_SEAT, NEWBIE]);
    let status: TeamStatus = listed();
    let memberIds = ids(NEWBIE);
    const { user } = openTeam(listed(), {
      team_status: () => status,
      team_refresh: () => status,
      team_billing_get: server.read,
      team_member_ids: () => memberIds,
      team_member_remove: () => {
        status = ownerStatus();
        memberIds = ids();
        return {
          login: "newbie",
          removed: ["owner/test-team"],
          cancelledInvitations: [],
          stillRead: [],
          failed: [],
          manifestUpdated: true,
          manifestError: null,
          seatFreed: false,
          seatError: "newbie is out of the team on GitHub, but their seat is still taken (offline). Free it from Members.",
        };
      },
    });
    const section = await members();
    await user.click(await section.findByRole("button", { name: "More for newbie" }));
    await user.click(await screen.findByRole("menuitem", { name: "Remove from team…" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Remove from team" }));
    expect(await section.findByText(/Free it from Members\./)).toBeTruthy();
    expect(await section.findByText("seat only")).toBeTruthy();
    expect(within(row(section, "newbie")).getByRole("button", { name: "Free the seat" })).toBeTruthy();
  });

  it("a member GitHub couldn't look up: no row yet, but it names the way, and Read it again brings the row", async () => {
    signedIn();
    const server = seats([OWNER_SEAT, JOINED_SEAT, NEWBIE]);
    let unresolved = true;
    const { user } = openTeam(ownerStatus(), {
      team_billing_get: server.read,
      team_member_ids: () =>
        unresolved ? { members: [OWNER_SEAT], unresolved: ["joined"] } : ids(),
    });
    const section = await members();
    expect(await section.findByText(/Couldn't look up joined on GitHub/)).toBeTruthy();
    expect(section.queryByRole("button", { name: "Free the seat" })).toBeNull();
    unresolved = false;
    await user.click(screen.getByRole("button", { name: "Read it again" }));
    expect(await section.findByRole("button", { name: "Free the seat" })).toBeTruthy();
  });

  it("an add that stopped after the manifest offers Remove from team… at once, and no Free the seat", async () => {
    signedIn();
    const server = seats([OWNER_SEAT, JOINED_SEAT]);
    let status = ownerStatus();
    let memberIds = ids();
    const { user } = openTeam(ownerStatus(), {
      team_status: () => status,
      team_refresh: () => status,
      team_billing_get: server.read,
      team_member_ids: () => memberIds,
      team_invite_plan: plan,
      team_invite_apply: () => {
        server.take();
        status = listed();
        memberIds = ids(NEWBIE);
        throw new Error(`The team changed while you were reading the invite. newbie is now listed in the team manifest; nothing was granted on GitHub. ${WORDS}`);
      },
    });
    const section = await members();
    await section.findAllByText("2 of 5 seats");
    await failedSend(user, section);
    await section.findAllByText("3 of 5 seats");
    expect(await section.findByRole("button", { name: "More for newbie" })).toBeTruthy();
    await waitFor(() => expect(section.queryByText("seat only")).toBeNull());
    expect(section.queryByRole("button", { name: "Free the seat" })).toBeNull();
    // Their row's own press, as the words say.
    await user.click(section.getByRole("button", { name: "More for newbie" }));
    expect(await screen.findByRole("menuitem", { name: "Remove from team…" })).toBeTruthy();
  });

  it("while the ids of a list that just changed are being read, nobody it lists is called seat only", async () => {
    signedIn();
    const server = seats([OWNER_SEAT, JOINED_SEAT, NEWBIE]);
    let status = ownerStatus();
    let hold = false;
    const { user } = openTeam(ownerStatus(), {
      team_status: () => status,
      team_refresh: () => status,
      team_billing_get: server.read,
      team_member_ids: () => (hold ? new Promise(() => {}) : ids()),
      team_invite_plan: plan,
      team_invite_apply: () => {
        status = listed();
        hold = true;
        throw new Error(`newbie is now listed in the team manifest; nothing was granted on GitHub. ${WORDS}`);
      },
    });
    const section = await members();
    expect(await section.findByText("seat only")).toBeTruthy();
    await failedSend(user, section);
    expect(await section.findByRole("button", { name: "More for newbie" })).toBeTruthy();
    expect(section.queryByText("seat only")).toBeNull();
    expect(section.queryByRole("button", { name: "Free the seat" })).toBeNull();
  });

  it("the members' ids couldn't be read at all: the page says so, and Read it again brings the row", async () => {
    signedIn();
    const server = seats([OWNER_SEAT, JOINED_SEAT, NEWBIE]);
    let fail = true;
    const { user } = openTeam(ownerStatus(), {
      team_billing_get: server.read,
      team_member_ids: () => {
        if (fail) throw new Error("The team repo is not on this Mac yet — refresh first.");
        return ids();
      },
    });
    const section = await members();
    await section.findAllByText("3 of 5 seats");
    const words =
      "Plyloft couldn't read the team's members, so seats held by people outside the team aren't shown: The team repo is not on this Mac yet — refresh first.";
    expect(await section.findByText(words)).toBeTruthy();
    expect(section.queryByRole("button", { name: "Free the seat" })).toBeNull();
    fail = false;
    await user.click(screen.getByRole("button", { name: "Read it again" }));
    expect(await section.findByRole("button", { name: "Free the seat" })).toBeTruthy();
    expect(section.queryByText(words)).toBeNull();
  });
});

describe("T3 and the team's plan", () => {
  const gates = (team: PlanGates["team"], refusal: string | null = "Team plan needed: …"): PlanGates => ({
    ...FREE_GATES,
    team,
    teamAllowed: false,
    teamRefusal: refusal,
  });

  it("a member without a seat is told whom to ask", async () => {
    signIn({ ...ME, login: "joined", sub: "2" });
    setPlanGates(gates({ state: "no_seat", owner: "owner", teamRepo: "owner/test-team" }));
    openTeam(ownerStatus({ isOwner: false, login: "joined" }), { team_billing_get: billing({ stage: "choose" }) });
    expect(await screen.findByText("Ask owner to give you a seat")).toBeTruthy();
  });

  it("another Plyloft account than the team's gets the D10 words", async () => {
    signIn({ ...ME, login: "someone-else" });
    setPlanGates(
      gates(
        { state: "other_account", login: "someone-else", teamLogin: "joined" },
        "Signed in as another account: you're signed in to Plyloft as someone-else, and the team uses the GitHub account joined.",
      ),
    );
    openTeam(ownerStatus({ isOwner: false, login: "joined" }), { team_billing_get: billing({ stage: "choose" }) });
    expect(await screen.findByText("Signed in to Plyloft as another account")).toBeTruthy();
    expect(screen.getByText(/the team uses the GitHub account joined/)).toBeTruthy();
  });

  describe("A3: the joined-team notice without an account, or with the team elsewhere", () => {
    const heard = () => screen.queryByText("Sign in to use your seat");

    it("D21: signed out, a joined team says Sign in to use your seat, with the button and the code in place", async () => {
      signIn(SIGNED_OUT);
      setPlanGates(null);
      const { user, tauri } = openTeam(ownerStatus({ isOwner: false, login: "joined" }), {
        team_billing_get: billing({ stage: "sign_in" }),
        account_sign_in_start: { attempt: 1, userCode: "WDJB-MJHT", verificationUri: "https://github.com/login/device", expiresIn: 900 },
        account_sign_in_cancel: null,
      });
      expect(await screen.findByText("Sign in to use your seat")).toBeTruthy();
      expect(
        screen.getByText(
          "Team features run on the seat the team's owner gives your GitHub account. Sign in to Plyloft with GitHub so Plyloft can find it.",
        ),
      ).toBeTruthy();
      await user.click(screen.getByRole("button", { name: "Sign in with GitHub" }));
      expect(tauri.callsOf("account_sign_in_start")).toHaveLength(1);
      expect(await screen.findByText("WDJB-MJHT")).toBeTruthy();
    });

    it("D21, owner: signed out, the team's own owner is not told about a seat", async () => {
      signIn(SIGNED_OUT);
      setPlanGates(null);
      openTeam(ownerStatus({ isOwner: true }), { team_billing_get: billing({ stage: "sign_in" }) });
      expect(await screen.findByText("Sign in to use your Team plan")).toBeTruthy();
      expect(screen.getByText("Sign in to Plyloft with the GitHub account you use for this team.")).toBeTruthy();
      expect(heard()).toBeNull();
      expect(screen.getByRole("button", { name: "Sign in with GitHub" })).toBeTruthy();
    });

    it("signed in with the team's seat here: no sign-in notice and no pointer", async () => {
      signIn({ ...ME, login: "joined", sub: "2", team: { state: "here", device: null, teamRepo: "owner/test-team", role: "member" } });
      setTeamAllowed(true);
      openTeam(ownerStatus({ isOwner: false, login: "joined" }), { team_billing_get: billing({ stage: "choose" }) });
      await waitFor(() => expect(document.body.textContent).toContain("owner/test-team"));
      expect(heard()).toBeNull();
      expect(screen.queryByRole("button", { name: "See your plan" })).toBeNull();
    });

    it("Team active on another computer: the Plan page's title and See your plan", async () => {
      signIn({ ...ME, login: "joined", sub: "2", team: { state: "elsewhere", device: "MacBook Pro", teamRepo: "owner/test-team", role: "member" } });
      setPlanGates(FREE_GATES);
      openTeam(ownerStatus({ isOwner: false, login: "joined" }), { team_billing_get: billing({ stage: "choose" }) });
      expect(await screen.findByText("Team is on another computer (MacBook Pro)")).toBeTruthy();
      expect(screen.getByRole("button", { name: "See your plan" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Use Team on this computer" })).toBeNull();
      expect(heard()).toBeNull();
    });

    it("a seat or plan not chosen anywhere yet: the title, and See your plan", async () => {
      signIn({ ...ME, login: "joined", sub: "2", team: { state: "nowhere", device: null, teamRepo: "owner/test-team", role: "member" } });
      setPlanGates(FREE_GATES);
      openTeam(ownerStatus({ isOwner: false, login: "joined" }), { team_billing_get: billing({ stage: "choose" }) });
      expect(await screen.findByText("Your seat on owner/test-team is ready")).toBeTruthy();
      expect(screen.getByRole("button", { name: "See your plan" })).toBeTruthy();
    });
  });

  it("the team's plan has ended: the owner renews with the team's seats", async () => {
    signIn();
    setPlanGates(gates({ state: "no_team_plan" }));
    const { user, tauri } = openTeam(ownerStatus(), {
      team_billing_get: billing(
        { stage: "lapsed", owner: true, ownerLogin: "owner", teamRepo: "owner/test-team", seats: 4 },
        team({ status: "canceled", seats: 4 }),
      ),
      account_checkout: () => null,
      team_checkout_wait: () => new Promise(() => {}),
    });
    expect(await screen.findByText("The team's plan has ended")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Renew" }));
    // The interval isn't known: it is asked, with the team's seats.
    expect(await screen.findByText("4 seats · €36 a month, VAT included.")).toBeTruthy();
    expect(tauri.callsOf("account_checkout")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Renew" }));
    await waitFor(() => expect(tauri.callsOf("account_checkout")[0]?.args).toEqual({ plan: "team", interval: "month", seats: 4 }));
    expect(await screen.findByText("Waiting for the payment…")).toBeTruthy();
  });

  it("Renew keeps the team's own interval when the server says it", async () => {
    signIn();
    setPlanGates(gates({ state: "no_team_plan" }));
    const { user, tauri } = openTeam(ownerStatus(), {
      team_billing_get: billing(
        { stage: "lapsed", owner: true, ownerLogin: "owner", teamRepo: "owner/test-team", seats: 4 },
        team({ status: "canceled", seats: 4, interval: "year" }),
      ),
      account_checkout: () => null,
      team_checkout_wait: () => new Promise(() => {}),
    });
    await user.click(await screen.findByRole("button", { name: "Renew" }));
    await waitFor(() => expect(tauri.callsOf("account_checkout")[0]?.args).toEqual({ plan: "team", interval: "year", seats: 4 }));
  });

  it("an unpaid team goes to billing, not to a new Checkout", async () => {
    signIn();
    setPlanGates(gates({ state: "no_team_plan" }));
    const { user, tauri } = openTeam(ownerStatus(), {
      team_billing_get: billing(
        { stage: "lapsed", owner: true, ownerLogin: "owner", teamRepo: "owner/test-team", seats: 3 },
        team({ status: "unpaid" }),
      ),
      account_portal: null,
    });
    expect(await screen.findByText(/payment needs attention/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Renew" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Open billing" }));
    await waitFor(() => expect(tauri.callsOf("account_portal")).toHaveLength(1));
    expect(tauri.callsOf("account_checkout")).toHaveLength(0);
  });

  it("the team's plan has ended: a member is told the owner's name", async () => {
    signIn({ ...ME, login: "joined", sub: "2" });
    setPlanGates(gates({ state: "no_team_plan" }));
    openTeam(ownerStatus({ isOwner: false, login: "joined" }), {
      team_billing_get: billing(
        { stage: "lapsed", owner: false, ownerLogin: "owner", teamRepo: "owner/test-team", seats: 3 },
        team({ status: "canceled" }),
      ),
    });
    expect(await screen.findByText("Team features are paused. Ask owner to renew it.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Renew" })).toBeNull();
  });

  it("Finish is never offered to a member who has a Team plan of their own", async () => {
    signIn({ ...TEAM_OWNER, login: "joined", sub: "2" });
    setPlanGates({
      ...TEAM_GATES,
      team: { state: "other_repo", planRepo: null, teamRepo: "owner/test-team" },
      teamAllowed: false,
      teamRefusal: "Your Team plan is for another team: …",
    });
    openTeam(ownerStatus({ isOwner: false, login: "joined" }), { team_billing_get: billing({ stage: "create", comp: false }) });
    await screen.findByText(/Member of/);
    expect(screen.queryByText("Finish creating your team")).toBeNull();
  });

  it("a repository not attached to the plan yet: Finish", async () => {
    signIn(TEAM_OWNER);
    setPlanGates({
      ...TEAM_GATES,
      team: { state: "other_repo", planRepo: null, teamRepo: "owner/test-team" },
      teamAllowed: false,
      teamRefusal: "Your Team plan is for another team: …",
    });
    const { user, tauri } = openTeam(ownerStatus(), {
      team_billing_get: billing({ stage: "create", comp: false }),
      team_bind_current: { ...TEAM_OWNER, teamRepo: "owner/test-team" },
      plan_gates_get: TEAM_GATES,
    });
    expect(await screen.findByText("Finish creating your team")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Finish" }));
    await waitFor(() => expect(tauri.callsOf("team_bind_current")).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText("Finish creating your team")).toBeNull());
  });
});
