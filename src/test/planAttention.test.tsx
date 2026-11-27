// QoL 1.168 block 12 (G21), rewritten for 1.178.0 (A3 b, D14–D17): the
// sidebar's plan row is only for Team. A Team plan whose check, payment or end
// needs a look says so; a Team plan or seat active on another computer, or
// ready and not chosen, says so with Use Team on this computer — only on a
// computer that follows that team. Free, on one computer or two, has no row
// and no notice: no device, no "not checked", no offline note.
import { describe, expect, it } from "vitest";
import { PlanPage } from "../components/settings/PlanPage";
import { PlanStatusRow } from "../components/SidebarStatus";
import type { AccountInfo, AccountTeam } from "../ipc";
import {
  ENDING_SOON_MS,
  TEAM_ELSEWHERE_TEXT,
  TEAM_READY_TEXT,
  USE_TEAM_HERE,
  followsTeam,
  notFoundText,
  offlineNote,
  planAttention,
  planUnverified,
  planUnverifiedText,
  teamChoice,
} from "../lib/planPage";
import { otherComputer } from "../lib/signIn";
import { useAccount } from "../store/accountStore";
import { DEFAULT_SETTINGS, useSettings } from "../store/settingsStore";
import { TEAM_GATES } from "./planGates";
import { act, renderUi, screen, waitFor, within } from "./render";

const CHECKED = Date.UTC(2026, 9, 2, 9, 30);
const NOW = Date.UTC(2026, 9, 21, 12);

const TEAM: AccountInfo = {
  signedIn: true,
  login: "octocat",
  sub: "1",
  plan: "team",
  teamRepo: "acme/team",
  teamRole: "owner",
  status: "active",
  periodEnd: Date.UTC(2026, 10, 2),
  exp: Date.UTC(2099, 0, 1),
  comp: false,
  entitlementValid: true,
  lastCheckedAt: CHECKED,
  offline: false,
  lastKnownPlan: "team",
  team: { state: "here", device: null, teamRepo: "acme/team", role: "owner" },
  deviceName: "MacBook Pro",
};
const FREE: AccountInfo = {
  ...TEAM,
  plan: "free",
  teamRepo: null,
  teamRole: null,
  status: null,
  periodEnd: null,
  lastKnownPlan: "free",
  team: null,
};
const seat = (team: Partial<AccountTeam>): AccountInfo => ({
  ...FREE,
  team: { state: "nowhere", device: null, teamRepo: "acme/team", role: "member", ...team },
});
/** A seat active on the MacBook Pro, read on the Mac mini (A3 b, scene 4a). */
const ELSEWHERE = seat({ state: "elsewhere", device: "MacBook Pro" });
/** A seat no computer has chosen yet (D15). */
const READY = seat({ state: "nowhere" });
/** A Team plan that ran out while the server couldn't be reached (12.2). */
const UNCHECKED: AccountInfo = { ...TEAM, plan: "free", status: null, periodEnd: null, exp: null, entitlementValid: false, offline: true };

function followTeam(teamRepo: string | null) {
  act(() =>
    useSettings.setState({
      settings: { ...DEFAULT_SETTINGS, team: { ...DEFAULT_SETTINGS.team, teamRepo } },
      loaded: true,
    } as never),
  );
}

describe("planAttention: only Team has a row", () => {
  it("never a row for a Free account, signed in or not, whatever its state", () => {
    expect(planAttention(null, true, NOW)).toBeNull();
    expect(planAttention({ ...FREE, signedIn: false }, true, NOW)).toBeNull();
    expect(planAttention(FREE, true, NOW)).toBeNull();
    // An expired Free token, offline: Free stays Free — no "not checked".
    const lapsedFree = { ...FREE, exp: null, entitlementValid: false, offline: true };
    expect(planAttention(lapsedFree, true, NOW)).toBeNull();
    expect(planUnverified(lapsedFree)).toBe(false);
    expect(offlineNote({ ...FREE, offline: true })).toBeNull();
    // A Free token never verified at all.
    expect(planAttention({ ...lapsedFree, lastKnownPlan: null }, true, NOW)).toBeNull();
  });

  it("Team here: unchecked → Check now; payment → Fix; ending soon → Renew; otherwise none", () => {
    expect(planAttention(TEAM, true, NOW)).toBeNull();
    expect(planAttention(UNCHECKED, true, NOW)).toMatchObject({ tone: "warn", text: "Plan not checked since 2 Oct 2026", action: { label: "Check now", does: "check" } });
    expect(planAttention({ ...UNCHECKED, lastCheckedAt: null }, false, NOW)?.text).toBe("Plan not checked");
    expect(planAttention({ ...TEAM, status: "past_due" }, true, NOW)).toMatchObject({ text: "Payment problem", action: { label: "Fix", does: "portal" } });
    expect(planAttention({ ...TEAM, teamRole: "member", status: "past_due" }, true, NOW)).toMatchObject({
      text: "The team's payment has a problem",
      action: { does: "plan" },
    });
    const ending = { ...TEAM, cancelAtPeriodEnd: true, periodEnd: NOW + 3 * 24 * 3600 * 1000 };
    expect(planAttention(ending, true, NOW)).toMatchObject({ tone: "info", text: "Team ends 24 Oct 2026", action: { label: "Renew", does: "portal" } });
    expect(planAttention({ ...ending, periodEnd: NOW + ENDING_SOON_MS + 1 }, true, NOW)).toBeNull();
    expect(planAttention({ ...ending, comp: true }, true, NOW)).toBeNull();
  });

  it("D16: Team elsewhere, or a seat ready, on a computer that follows the team — two lines, accent dot", () => {
    expect(planAttention(ELSEWHERE, true, NOW)).toEqual({
      tone: "info",
      text: "Team is on another computer (MacBook Pro)",
      title: TEAM_ELSEWHERE_TEXT,
      action: { label: USE_TEAM_HERE, does: "use_team" },
      wrap: true,
    });
    expect(planAttention(READY, true, NOW)).toMatchObject({ tone: "info", text: "Your Team seat is ready", title: TEAM_READY_TEXT, action: { does: "use_team" } });
    expect(planAttention(seat({ role: "owner" }), true, NOW)?.text).toBe("Your Team plan is ready");
  });

  it("D16 (owner g.4): a computer that doesn't follow the team shows nothing in the sidebar", () => {
    expect(planAttention(ELSEWHERE, false, NOW)).toBeNull();
    expect(planAttention(READY, false, NOW)).toBeNull();
  });

  it("follows the team by its repository, as Settings › Team compares it", () => {
    expect(followsTeam(ELSEWHERE, "Acme/Team ")).toBe(true);
    expect(followsTeam(ELSEWHERE, "acme/other")).toBe(false);
    expect(followsTeam(ELSEWHERE, null)).toBe(false);
    expect(followsTeam(FREE, "acme/team")).toBe(false);
    expect(followsTeam(seat({ teamRepo: null }), null)).toBe(false);
  });
});

describe("teamChoice: one state per AccountInfo.team.state", () => {
  it("here: nothing to choose (Team runs here)", () => {
    expect(teamChoice(TEAM)).toBeNull();
  });

  it("elsewhere (D14): names the other computer by its generic label", () => {
    expect(teamChoice(ELSEWHERE)).toMatchObject({ state: "elsewhere", title: "Team is on another computer (MacBook Pro)", text: TEAM_ELSEWHERE_TEXT });
    expect(teamChoice(seat({ state: "elsewhere", device: null }))?.title).toBe("Team is on another computer");
  });

  it("nowhere (D15): the member's seat by its team, the owner's plan", () => {
    expect(teamChoice(READY)).toMatchObject({ state: "nowhere", title: "Your seat on acme/team is ready", text: TEAM_READY_TEXT });
    expect(teamChoice(seat({ role: "owner" }))?.title).toBe("Your Team plan is ready");
  });

  it("null: no Team plan or seat, signed out, or an old server that doesn't say", () => {
    expect(teamChoice(FREE)).toBeNull();
    expect(teamChoice({ ...ELSEWHERE, signedIn: false })).toBeNull();
    expect(teamChoice(null)).toBeNull();
  });

  // 1.175.0 (E-app, contract §6b): the server names the other computer by a
  // generic label; the sentences say "another computer (label)", so a label
  // never reads as a name, nor as this computer when both are one model.
  it("names the other computer as another computer", () => {
    expect(otherComputer("MacBook Pro")).toBe("another computer (MacBook Pro)");
    expect(otherComputer("  Windows PC ")).toBe("another computer (Windows PC)");
    expect(otherComputer("another device")).toBe("another computer");
    expect(otherComputer("")).toBe("another computer");
    expect(otherComputer("another computer (Mac mini)")).toBe("another computer (Mac mini)");
  });

  it("the unchecked words say Free keeps working", () => {
    expect(planUnverifiedText(UNCHECKED)).toMatch(/^Plyloft hasn't been able to check your plan since 2 Oct 2026, \d{2}:\d{2}, so this Mac is on Free until a check goes through\. Everything for one person keeps working; team features are off\. Your work is untouched\.$/);
  });
});

describe("Settings › Plan: Team on another computer, a seat ready, unchecked", () => {
  it("elsewhere: the callout says so, Use Team on this computer moves it here (D14, D17)", async () => {
    act(() => useAccount.setState({ loaded: true, info: ELSEWHERE, error: null }));
    const here: AccountInfo = { ...TEAM, teamRole: "member", team: { state: "here", device: null, teamRepo: "acme/team", role: "member" } };
    const { user, tauri } = renderUi(<PlanPage scope="this-mac" />, { withToasts: true, fixtures: { account_use_team: here, plan_gates_get: TEAM_GATES } });
    expect(screen.getByText("Team is on another computer (MacBook Pro)")).toBeTruthy();
    expect(screen.getByText(TEAM_ELSEWHERE_TEXT)).toBeTruthy();
    // Individual work goes on here: the plan row says Free.
    expect(screen.getByText("Free")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open Team" })).toBeNull();
    expect(screen.queryByText("This device")).toBeNull();
    const press = screen.getByRole("button", { name: USE_TEAM_HERE });
    expect(press.className).not.toContain("cbtn--accent");
    await user.click(press);
    await waitFor(() => expect(tauri.callsOf("account_use_team")).toHaveLength(1));
    expect(tauri.callsOf("account_sign_in_start")).toHaveLength(0);
    expect(await screen.findByText("Team is on this Mac now")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("Team is on another computer (MacBook Pro)")).toBeNull());
    expect(screen.getByText("Team · member")).toBeTruthy();
    expect(screen.getByText("This device")).toBeTruthy();
  });

  it("elsewhere: a refused move says why in a toast", async () => {
    act(() => useAccount.setState({ loaded: true, info: ELSEWHERE, error: null }));
    const { user } = renderUi(<PlanPage scope="this-mac" />, {
      withToasts: true,
      fixtures: {
        account_use_team: () => Promise.reject({ code: "rate_limited", message: "Team moved between computers too often today." }),
        account_get: ELSEWHERE,
      },
    });
    await user.click(screen.getByRole("button", { name: USE_TEAM_HERE }));
    expect(await screen.findByText(/^Team wasn't moved to this Mac\.?$/)).toBeTruthy();
    expect(await screen.findByText("Team moved between computers too often today.")).toBeTruthy();
  });

  it("a seat ready (D15): the member's title and the same button, on the page even when this Mac doesn't follow the team", () => {
    followTeam(null);
    act(() => useAccount.setState({ loaded: true, info: READY }));
    renderUi(<PlanPage scope="this-mac" />);
    expect(screen.getByText("Your seat on acme/team is ready")).toBeTruthy();
    expect(screen.getByText(TEAM_READY_TEXT)).toBeTruthy();
    expect(screen.getByRole("button", { name: USE_TEAM_HERE })).toBeTruthy();
  });

  it("a Team plan ready, for its owner (D15)", () => {
    act(() => useAccount.setState({ loaded: true, info: seat({ role: "owner" }) }));
    renderUi(<PlanPage scope="this-mac" />);
    expect(screen.getByText("Your Team plan is ready")).toBeTruthy();
  });

  it("unchecked Team: Free with the truth about it, and Check now asks the server", async () => {
    act(() => useAccount.setState({ loaded: true, info: UNCHECKED }));
    const { user, tauri } = renderUi(<PlanPage scope="this-mac" />, { fixtures: { account_refresh: TEAM } });
    expect(screen.getByText("Your plan isn't checked")).toBeTruthy();
    expect(
      screen.getAllByText(
        "Plyloft couldn't reach its server, and the plan it last checked has run out, so this Mac is on Free until a check goes through. Everything for one person keeps working; team features are off.",
      ).length,
    ).toBeGreaterThan(0);
    const [first] = screen.getAllByRole("button", { name: "Check now" });
    await user.click(first!);
    await waitFor(() => expect(tauri.callsOf("account_refresh")).toHaveLength(1));
  });

  it("an expired Free token, offline: no notice at all", () => {
    act(() => useAccount.setState({ loaded: true, info: { ...FREE, exp: null, entitlementValid: false, offline: true } }));
    renderUi(<PlanPage scope="this-mac" />);
    expect(screen.queryByText("Your plan isn't checked")).toBeNull();
    expect(screen.queryByText(/couldn't reach its server/)).toBeNull();
    expect(screen.queryByRole("button", { name: USE_TEAM_HERE })).toBeNull();
  });
});

describe("Sidebar plan row (G21, D16)", () => {
  it("draws nothing while the plan is fine, and nothing on Free", () => {
    for (const info of [TEAM, FREE, { ...FREE, exp: null, entitlementValid: false, offline: true }]) {
      act(() => useAccount.setState({ loaded: true, info }));
      const r = renderUi(<PlanStatusRow />);
      expect(screen.queryByRole("status")).toBeNull();
      r.unmount();
    }
  });

  it("Team elsewhere on a computer that follows the team: two lines, and Use Team on this computer moves it", async () => {
    followTeam("acme/team");
    act(() => useAccount.setState({ loaded: true, info: ELSEWHERE, error: null }));
    const { user, tauri } = renderUi(<PlanStatusRow />, { withToasts: true, fixtures: { account_use_team: TEAM, plan_gates_get: TEAM_GATES } });
    expect(screen.getByText("Team is on another computer (MacBook Pro)")).toBeTruthy();
    expect(document.querySelector(".shell-status--wrap .shell-dot--info")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: USE_TEAM_HERE }));
    await waitFor(() => expect(tauri.callsOf("account_use_team")).toHaveLength(1));
    expect(await screen.findByText("Team is on this Mac now")).toBeTruthy();
  });

  it("a seat ready on a computer that follows the team", () => {
    followTeam("acme/team");
    act(() => useAccount.setState({ loaded: true, info: READY }));
    renderUi(<PlanStatusRow />);
    expect(screen.getByText("Your Team seat is ready")).toBeTruthy();
    expect(screen.getByRole("button", { name: USE_TEAM_HERE })).toBeTruthy();
  });

  it("a computer that doesn't follow the team shows nothing", () => {
    followTeam("acme/other");
    act(() => useAccount.setState({ loaded: true, info: ELSEWHERE }));
    renderUi(<PlanStatusRow />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("unchecked Team: Check now refreshes; still unchecked says so", async () => {
    act(() => useAccount.setState({ loaded: true, info: UNCHECKED, error: null }));
    const { user, tauri } = renderUi(<PlanStatusRow />, { withToasts: true, fixtures: { account_refresh: UNCHECKED } });
    await user.click(screen.getByRole("button", { name: "Check now" }));
    await waitFor(() => expect(tauri.callsOf("account_refresh")).toHaveLength(1));
    expect(await screen.findByText("Plyloft couldn't check your plan.")).toBeTruthy();
  });

  it("payment problem: Fix opens billing", async () => {
    act(() => useAccount.setState({ loaded: true, info: { ...TEAM, status: "past_due" } }));
    const { user, tauri } = renderUi(<PlanStatusRow />, { fixtures: { account_portal: null } });
    await user.click(screen.getByRole("button", { name: "Fix" }));
    await waitFor(() => expect(tauri.callsOf("account_portal")).toHaveLength(1));
  });

  it("payment problem: when the billing page doesn't open, the sidebar says why", async () => {
    act(() => useAccount.setState({ loaded: true, info: { ...TEAM, status: "past_due" } }));
    const { user } = renderUi(<PlanStatusRow />, {
      withToasts: true,
      fixtures: { account_portal: () => Promise.reject({ code: "network", message: "Stripe's billing page couldn't be reached." }) },
    });
    await user.click(screen.getByRole("button", { name: "Fix" }));
    expect(await screen.findByText("Plyloft couldn't open the billing page.")).toBeTruthy();
    expect(await screen.findByText("Stripe's billing page couldn't be reached.")).toBeTruthy();
  });

  it("payment problem: a subscription Stripe can't find is said too", async () => {
    act(() => useAccount.setState({ loaded: true, info: { ...TEAM, status: "past_due" } }));
    const { user } = renderUi(<PlanStatusRow />, {
      withToasts: true,
      fixtures: { account_portal: () => Promise.reject({ code: "not_found", message: "No subscription." }) },
    });
    await user.click(screen.getByRole("button", { name: "Fix" }));
    expect(await screen.findByText("Plyloft couldn't open the billing page.")).toBeTruthy();
    expect(await screen.findByText(notFoundText(TEAM))).toBeTruthy();
  });
});

describe("Settings › Plan: Sign out other computers (Reviewer H1, D13) — Team here only", () => {
  it("asks first, then signs the others out and says how many", async () => {
    act(() => useAccount.setState({ loaded: true, info: TEAM }));
    const { user, tauri } = renderUi(<PlanPage scope="this-mac" />, { withToasts: true, fixtures: { account_sign_out_others: 2 } });
    await user.click(screen.getByRole("button", { name: "Sign out other computers" }));
    expect(tauri.callsOf("account_sign_out_others")).toHaveLength(0);
    const sheet = await screen.findByRole("dialog", { name: "Sign out your other computers?" });
    expect(sheet.textContent).toContain(
      "Every other computer signed in to your Plyloft account is signed out and needs a new sign-in. This one stays signed in. Use it if you no longer have a computer, or don't know one.",
    );
    // Destructive: Cancel has the initial focus, so Enter signs nobody out.
    await waitFor(() => expect(document.activeElement).toBe(within(sheet).getByRole("button", { name: "Cancel" })));
    await user.click(within(sheet).getByRole("button", { name: "Sign out other computers" }));
    await waitFor(() => expect(tauri.callsOf("account_sign_out_others")).toHaveLength(1));
    expect(await screen.findByText("2 other computers signed out")).toBeTruthy();
  });

  it("isn't offered on Free, nor while Team is on another computer or waits", () => {
    for (const info of [FREE, ELSEWHERE, READY]) {
      act(() => useAccount.setState({ loaded: true, info }));
      const { unmount } = renderUi(<PlanPage scope="this-mac" />);
      expect(screen.queryByRole("button", { name: "Sign out other computers" })).toBeNull();
      unmount();
    }
  });
});
