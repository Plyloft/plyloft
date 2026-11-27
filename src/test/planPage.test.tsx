// Launch A3 (LAUNCH_PLAN §2 D12, D14–D16; §5): Settings › Account › Plan,
// rendered on the real stores with the backend answering through the Tauri
// stub — `account_portal` (Stripe in the browser for a Team owner),
// `account_refresh` (the plan from the server). Only Team is paid: an
// entitlement that still says `pro` (an old comp) reads as Free.
// 1.178.0 (A3 b, D8–D13, D22, D25): signing in is optional and starts on this
// page; Free has no device row and no notice, on one computer or two.
import { describe, expect, it } from "vitest";
import { PlanPage } from "../components/settings/PlanPage";
import type { AccountError, AccountInfo } from "../ipc";
import {
  MEMBER_BILLING,
  NOT_FOUND_PAID,
  PAST_DUE,
  START_TEAM_HINT,
  TEAM_PAST_DUE,
  THIS_DEVICE_HINT,
  USE_TEAM_HERE,
  fmtDate,
  fmtDateTime,
} from "../lib/planPage";
import { DEV_SKIP_NOTE, SIGNIN_ABOUT } from "../lib/signIn";
import { useAccount } from "../store/accountStore";
import { useUi } from "../store/uiStore";
import { act, renderUi, screen, waitFor, within } from "./render";

const PERIOD_END = Date.UTC(2026, 10, 2);
const CHECKED = Date.UTC(2026, 9, 2, 9, 30);

const FREE: AccountInfo = {
  signedIn: true,
  login: "octocat",
  sub: "1",
  plan: "free",
  teamRepo: null,
  teamRole: null,
  status: null,
  periodEnd: null,
  exp: Date.UTC(2099, 0, 1),
  comp: false,
  entitlementValid: true,
  lastCheckedAt: CHECKED,
  offline: false,
  lastKnownPlan: "free",
  team: null,
  deviceName: "Matteo's MacBook",
};
/** An entitlement that still says `pro` (an old comp): Free here. */
const OLD_PRO: AccountInfo = { ...FREE, plan: "pro", status: "active", periodEnd: PERIOD_END };
const TEAM_OWNER: AccountInfo = {
  ...FREE,
  plan: "team",
  status: "active",
  periodEnd: PERIOD_END,
  teamRepo: "octocat/acme-team",
  teamRole: "owner",
  lastKnownPlan: "team",
  team: { state: "here", device: null, teamRepo: "octocat/acme-team", role: "owner" },
};
const PAST_DUE_TEAM: AccountInfo = { ...TEAM_OWNER, status: "past_due" };
const TEAM_MEMBER: AccountInfo = {
  ...TEAM_OWNER,
  teamRole: "member",
  team: { state: "here", device: null, teamRepo: "octocat/acme-team", role: "member" },
};
const COMP: AccountInfo = { ...FREE, plan: "team", teamRole: "owner", comp: true, status: null, lastKnownPlan: "team" };
const OFFLINE_TEAM: AccountInfo = { ...TEAM_OWNER, offline: true, exp: Date.UTC(2026, 10, 5) };
const SIGNED_OUT: AccountInfo = {
  ...FREE,
  signedIn: false,
  login: null,
  sub: null,
  exp: null,
  entitlementValid: false,
  lastCheckedAt: null,
  lastKnownPlan: null,
  deviceName: null,
};

const refusal = (code: AccountError["code"], message: string) => () =>
  Promise.reject({ code, message } satisfies AccountError);

function show(info: AccountInfo, fixtures: Record<string, unknown> = {}) {
  act(() => useAccount.setState({ loaded: true, info }));
  return renderUi(<PlanPage scope="this-mac" />, { fixtures });
}

const button = (name: string) => screen.getByRole("button", { name });

describe("Settings › Plan: the plan as it stands", () => {
  it("Free: the plan, Start a team, no upgrade and no subscription to manage", () => {
    show(FREE);
    expect(screen.getByRole("heading", { level: 1, name: "Plan" })).toBeTruthy();
    expect(screen.getByText("Free")).toBeTruthy();
    expect(screen.getByText("You can run cards in parallel and use all individual features for free.")).toBeTruthy();
    expect(screen.queryByText(/€9|86\.40|Pro\b|Upgrade/)).toBeNull();
    expect(screen.queryByRole("group", { name: "Billing period" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Upgrade" })).toBeNull();
    expect(screen.getByText(START_TEAM_HINT)).toBeTruthy();
    expect(button("Open Team")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Manage subscription" })).toBeNull();
    // D25: the second section is the account; Free has no device row (D12)
    // and no Sign out other computers (D13).
    expect(screen.getByRole("heading", { level: 2, name: "Plyloft account" })).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 2, name: "This device" })).toBeNull();
    expect(screen.queryByText("This device")).toBeNull();
    expect(screen.queryByText("Matteo's MacBook")).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign out other computers" })).toBeNull();
    // D10: the account row, signed in.
    expect(screen.getByText("octocat")).toBeTruthy();
    expect(
      screen.getByText(
        "Your GitHub sign-in, used only to start or join a team. This is separate from the GitHub accounts Plyloft uses for pull requests.",
      ),
    ).toBeTruthy();
    expect(button("Sign out")).toBeTruthy();
    // When the plan was last checked.
    expect(screen.getByText(fmtDateTime(CHECKED))).toBeTruthy();
    expect(button("Check now")).toBeTruthy();
  });

  it("D22: the lede says plan and account", () => {
    show(FREE);
    expect(screen.getByText("Your Plyloft plan and account, and where to manage the team's subscription.")).toBeTruthy();
  });

  it("Free on a second computer: the same page, no notice of any kind (A3 b, scene 3)", () => {
    // What the Mac mini reads while the MacBook Pro stays signed in too.
    const second: AccountInfo = { ...FREE, deviceName: "Mac mini" };
    show(second);
    expect(screen.queryByRole("button", { name: USE_TEAM_HERE })).toBeNull();
    expect(screen.queryByRole("button", { name: "Use it here" })).toBeNull();
    expect(screen.queryByText(/another computer|isn't checked|couldn't reach|One device/)).toBeNull();
    expect(document.querySelector(".ux-callout")).toBeNull();
    expect(screen.getByText("Free")).toBeTruthy();
  });

  it("Free offline, or with its token run out: Free stays Free, no note", () => {
    show({ ...FREE, offline: true, exp: null, entitlementValid: false });
    expect(screen.queryByText(/couldn't reach its server|isn't checked/)).toBeNull();
    expect(screen.getByText("Plyloft asks for your plan every 6 hours, and when you come back to its window.")).toBeTruthy();
  });

  it("an entitlement that says pro reads exactly as Free: no Pro, no period, no subscription", () => {
    show(OLD_PRO);
    expect(screen.getByText("Free")).toBeTruthy();
    expect(screen.queryByText(/Pro\b/)).toBeNull();
    expect(screen.queryByText(/Renews on|Ends on|Included/)).toBeNull();
    expect(screen.getByText("You can run cards in parallel and use all individual features for free.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Manage subscription" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Upgrade" })).toBeNull();
    expect(screen.getByText(START_TEAM_HINT)).toBeTruthy();
    expect(button("Open Team")).toBeTruthy();
  });

  it("an old comp that says pro reads as Free, not Included", () => {
    show({ ...OLD_PRO, comp: true });
    expect(screen.getByText("Free")).toBeTruthy();
    expect(screen.queryByText(/Included/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Manage subscription" })).toBeNull();
  });

  it("Team cancelled at period end: ends on its date, not renewing", () => {
    show({ ...TEAM_OWNER, cancelAtPeriodEnd: true });
    expect(screen.getByText(`For the team octocat/acme-team. Ends on ${fmtDate(PERIOD_END)} · not renewing.`)).toBeTruthy();
    expect(screen.queryByText(/Renews on/)).toBeNull();
    expect(button("Manage subscription")).toBeTruthy();
  });

  it("past_due: says the payment problem, and Manage subscription is the way out", () => {
    show(PAST_DUE_TEAM);
    expect(screen.getByText(PAST_DUE)).toBeTruthy();
    expect(screen.getByText(/update your card in the billing portal/)).toBeTruthy();
    expect(button("Manage subscription").className).toContain("cbtn--accent");
    // D12: the plan stays while Stripe retries.
    expect(screen.getByText("Team · owner")).toBeTruthy();
  });

  it("Team owner names the role and the team, and manages the subscription; no Start a team", () => {
    show(TEAM_OWNER);
    expect(screen.getByText("Team · owner")).toBeTruthy();
    expect(screen.getByText(`For the team octocat/acme-team. Renews on ${fmtDate(PERIOD_END)}.`)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open Team" })).toBeNull();
    expect(button("Manage subscription")).toBeTruthy();
  });

  it("Team here (D12, D13): This device names this computer, with Sign out other computers", () => {
    show(TEAM_OWNER);
    expect(screen.getByText("This device")).toBeTruthy();
    expect(screen.getByText(THIS_DEVICE_HINT)).toBeTruthy();
    expect(screen.getByText("Matteo's MacBook")).toBeTruthy();
    expect(button("Sign out other computers")).toBeTruthy();
    expect(screen.queryByRole("button", { name: USE_TEAM_HERE })).toBeNull();
  });

  it("Team here for a member: the same device row", () => {
    show(TEAM_MEMBER);
    expect(screen.getByText(THIS_DEVICE_HINT)).toBeTruthy();
    expect(button("Sign out other computers")).toBeTruthy();
  });

  it("Team member: billing is the owner's — no Manage subscription", () => {
    show(TEAM_MEMBER);
    expect(screen.getByText("Team · member")).toBeTruthy();
    expect(screen.getByText(MEMBER_BILLING)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Manage subscription" })).toBeNull();
  });

  it("Team member with a payment problem: the owner is on it, no portal", () => {
    show({ ...TEAM_MEMBER, status: "past_due" });
    expect(screen.getByText(TEAM_PAST_DUE)).toBeTruthy();
    expect(screen.queryByText(PAST_DUE)).toBeNull();
    expect(screen.queryByRole("button", { name: "Manage subscription" })).toBeNull();
  });

  it("comp: Included, nothing to pay, renew or manage", () => {
    show(COMP);
    expect(screen.getByText("Team · Included")).toBeTruthy();
    expect(screen.getByText(/Included with your account: nothing to pay or renew\./)).toBeTruthy();
    expect(screen.queryByText(/Renews on|Ends on/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Manage subscription" })).toBeNull();
  });

  it("offline: the last checked plan holds until it expires, and says so", () => {
    show(OFFLINE_TEAM);
    const note = `Plyloft couldn't reach its server, so this is the plan it last checked. It holds until ${fmtDate(OFFLINE_TEAM.exp!)}.`;
    // In the status and under Last checked.
    expect(screen.getAllByText(note)).toHaveLength(2);
    expect(screen.getByText(fmtDateTime(CHECKED))).toBeTruthy();
    expect(screen.getByText("Team · owner")).toBeTruthy();
  });

  it("signed out (D9, D23): Free, Start a team, Sign in with GitHub bordered; no Sign out, no Last checked", () => {
    show(SIGNED_OUT);
    expect(screen.getByText("Free")).toBeTruthy();
    expect(
      screen.getByText("All individual features are free. You only need a Plyloft account to start or join a team."),
    ).toBeTruthy();
    // D8: no status line of its own; the Plan row and the account row say it.
    expect(screen.queryByText("Not signed in to Plyloft.")).toBeNull();
    expect(button("Open Team")).toBeTruthy();
    expect(screen.getByText("not signed in")).toBeTruthy();
    expect(screen.getByText(SIGNIN_ABOUT)).toBeTruthy();
    const signIn = button("Sign in with GitHub");
    expect(signIn.className).not.toContain("cbtn--accent");
    expect(screen.queryByRole("button", { name: "Upgrade" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Check now" })).toBeNull();
    expect(screen.queryByText("Last checked")).toBeNull();
    expect(screen.queryByText("This device")).toBeNull();
    expect(document.querySelector(".cbtn--accent")).toBeNull();
  });

  it("signed out in a dev run that skips sign-in: the note, no Sign in button", () => {
    act(() => useAccount.setState({ devSkip: true }));
    show(SIGNED_OUT);
    expect(screen.getByText(DEV_SKIP_NOTE)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign in with GitHub" })).toBeNull();
  });
});

describe("Settings › Plan: signing in and out (D9, D11)", () => {
  it("Sign in with GitHub shows the code on this page, with Cancel", async () => {
    act(() => useAccount.setState({ signIn: null, progress: null, error: null, attempt: 0, devSkip: false }));
    const { user, tauri } = show(SIGNED_OUT, {
      account_sign_in_start: { attempt: 1, userCode: "WDJB-MJHT", verificationUri: "https://github.com/login/device", expiresIn: 900 },
    });
    await user.click(button("Sign in with GitHub"));
    expect(await screen.findByText("WDJB-MJHT")).toBeTruthy();
    expect(tauri.callsOf("account_sign_in_start")).toHaveLength(1);
    expect(button("Cancel")).toBeTruthy();
    // While the code waits, the row offers no second sign-in.
    expect(screen.queryByRole("button", { name: "Sign in with GitHub" })).toBeNull();
  });

  it("a sign-in that fails says why under the row, with its way out", async () => {
    act(() => useAccount.setState({ signIn: null, progress: null, attempt: 0, devSkip: false, error: { code: "expired_token", message: "expired" } }));
    show(SIGNED_OUT);
    expect(screen.getByText("The code expired before it was entered on GitHub.")).toBeTruthy();
    expect(button("Get a new code")).toBeTruthy();
  });

  it("Sign out asks first, in words that say individual work goes on", async () => {
    const { user, tauri } = show(FREE, { account_sign_out: SIGNED_OUT });
    await user.click(button("Sign out"));
    const sheet = await screen.findByRole("dialog", { name: "Sign out of Plyloft?" });
    expect(sheet.textContent).toContain(
      "Everything for one person keeps working. Team features turn off on this Mac until you sign in again.",
    );
    expect(sheet.textContent).not.toContain("sign-in screen");
    await user.click(within(sheet).getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(tauri.callsOf("account_sign_out")).toHaveLength(1));
    await waitFor(() => expect(screen.getByText("not signed in")).toBeTruthy());
  });
});

describe("Settings › Plan: Manage subscription, Check now", () => {
  it("opens the billing portal on a paid plan", async () => {
    const { user, tauri } = show(TEAM_OWNER, { account_portal: null });
    await user.click(button("Manage subscription"));
    await waitFor(() => expect(tauri.callsOf("account_portal")).toHaveLength(1));
  });

  it("not_found on a plan this account pays for says so in its own words", async () => {
    const { user } = show(TEAM_OWNER, { account_portal: refusal("not_found", "You have no subscription yet.") });
    await user.click(button("Manage subscription"));
    expect(await screen.findByText(NOT_FOUND_PAID)).toBeTruthy();
  });

  it("Check now asks the server and shows the new time", async () => {
    const later = Date.UTC(2026, 9, 2, 11, 0);
    const { user, tauri } = show(FREE, { account_refresh: { ...TEAM_OWNER, lastCheckedAt: later } });
    await user.click(button("Check now"));
    await waitFor(() => expect(screen.getByText(fmtDateTime(later))).toBeTruthy());
    expect(tauri.callsOf("account_refresh")).toHaveLength(1);
    expect(screen.getByText("Team · owner")).toBeTruthy();
  });

  it("Check now that fails says why on the page, and leaves sign-in's error alone", async () => {
    const { user } = show(TEAM_OWNER, {
      account_refresh: refusal("keychain", "Plyloft couldn't read its sign-in from the keychain."),
    });
    await user.click(button("Check now"));
    expect(await screen.findByText("Plyloft couldn't read its sign-in from the keychain.")).toBeTruthy();
    expect(screen.getByText("Team · owner")).toBeTruthy();
    expect(useAccount.getState().error).toBeNull();
  });

  it("Start a team opens Settings › Team", async () => {
    const { user } = show(FREE);
    await user.click(button("Open Team"));
    expect(useUi.getState().settingsSection).toBe("team-workspaces");
  });

  it("is a row per thing the page says (search lands on them)", () => {
    show(TEAM_OWNER);
    for (const label of ["Plan", "Subscription", "Plyloft account", "This device", "Last checked"]) {
      const found = screen.getAllByText(label).map((el) => el.closest(".ux-row"));
      expect(found.some(Boolean), label).toBe(true);
    }
  });
});

// N14 walk F12: the Plan page's dates are English whatever the Mac's region
// (the walk read "4 ott 2026" on an Italian Mac).
describe("Plan dates", () => {
  it("are formatted in English", () => {
    const noon = Date.UTC(2026, 9, 4, 12);
    expect(fmtDate(noon)).toBe("4 Oct 2026");
    expect(fmtDateTime(noon)).toMatch(/^4 Oct 2026, \d{2}:\d{2}$/);
  });
});

// 1.175.0 D5 (SRV-2): someone was given a seat on a team this Mac never
// joined, and nothing let them out of it. The notice now has the way out.
describe("Settings › Plan: a seat on a team this Mac isn't in", () => {
  const AWAY: AccountInfo = {
    ...TEAM_MEMBER,
    teamRepo: "acme/widgets-team",
    team: { state: "here", device: null, teamRepo: "acme/widgets-team", role: "member" },
  };

  it("says it with Give up the seat…, asks with the focus on Cancel, and frees the seat", async () => {
    const { user, tauri } = show(AWAY, { seat_give_up: () => true });
    expect(screen.getByText("You hold a seat on acme/widgets-team.")).toBeTruthy();
    expect(
      screen.getByText("One team per account. Join that team in Settings › Team › Members and library instead, or give up the seat."),
    ).toBeTruthy();
    await user.click(button("Give up the seat…"));
    const sheet = await screen.findByRole("dialog", { name: "Give up your seat on acme/widgets-team?" });
    expect(sheet.textContent).toContain(
      "You hold a seat on its Team plan, and this Mac isn't in that team. Giving it up lets you join another team or start your own. This frees your seat on this team across all your computers. Nothing on this Mac or on GitHub changes.",
    );
    await waitFor(() => expect(document.activeElement).toBe(within(sheet).getByRole("button", { name: "Cancel" })));
    expect(tauri.callsOf("seat_give_up")).toHaveLength(0);
    await user.click(within(sheet).getByRole("button", { name: "Give up the seat" }));
    await waitFor(() => expect(tauri.callsOf("seat_give_up")).toHaveLength(1));
  });

  it("says what giving the seat up frees when Team is active elsewhere or on none yet", async () => {
    const lede = async (team: AccountInfo["team"]) => {
      const { user, unmount } = show({ ...AWAY, plan: "free", team }, { seat_give_up: () => true });
      await user.click(button("Give up the seat…"));
      const sheet = await screen.findByRole("dialog", { name: "Give up your seat on acme/widgets-team?" });
      const text = sheet.textContent ?? "";
      unmount();
      return text;
    };
    const says = "This frees your seat on this team across all your computers.";
    expect(await lede({ state: "elsewhere", device: "MacBook Pro", teamRepo: "acme/widgets-team", role: "member" })).toContain(says);
    expect(await lede({ state: "nowhere", device: null, teamRepo: "acme/widgets-team", role: "member" })).toContain(says);
  });

  it("changes nothing on Cancel, and says a refusal in plain words", async () => {
    const { user, tauri } = renderWithToasts(AWAY, { seat_give_up: () => Promise.reject({ kind: "unsupported", message: "Not found." }) });
    await user.click(button("Give up the seat…"));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(tauri.callsOf("seat_give_up")).toHaveLength(0);
    await user.click(button("Give up the seat…"));
    await user.click(await screen.findByRole("button", { name: "Give up the seat" }));
    expect(await screen.findByText(/^Couldn't give up the seat\.?$/)).toBeTruthy();
    expect(
      screen.getByText("Plyloft's account service couldn't free your seat yet, so your seat is still yours. Try again later."),
    ).toBeTruthy();
  });

  it("is not shown for the owner, a comp, a member of the team this Mac is in, or Free", () => {
    for (const info of [TEAM_OWNER, COMP, FREE, OLD_PRO]) {
      const r = show(info);
      expect(screen.queryByRole("button", { name: "Give up the seat…" })).toBeNull();
      r.unmount();
    }
  });
});

function renderWithToasts(info: AccountInfo, fixtures: Record<string, unknown>) {
  act(() => useAccount.setState({ loaded: true, info }));
  return renderUi(<PlanPage scope="this-mac" />, { fixtures, withToasts: true });
}
