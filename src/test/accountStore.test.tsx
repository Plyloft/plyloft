// Launch A1: the account store mirrors the backend's AccountInfo, follows
// `account://changed` and `account://sign-in`, and keeps the backend's typed
// errors. 1.178.0 (A3): the account is optional — nothing requires it, Use
// Team on this computer is the store's `useTeam`, and a session the server
// ended goes signed out silently (a toast only where a team is followed).
import { describe, expect, it } from "vitest";
import type { AccountInfo } from "../ipc";
import { accountReady, currentPlan, startAccountListeners, useAccount } from "../store/accountStore";
import { setupIsOpen, useSetup } from "../store/setupStore";
import { DEFAULT_SETTINGS, useSettings } from "../store/settingsStore";
import { useToasts } from "../store/toastStore";
import { act } from "./render";
import { tauri } from "./tauri";

const SIGNED_OUT: AccountInfo = {
  signedIn: false,
  login: null,
  sub: null,
  plan: "free",
  teamRepo: null,
  teamRole: null,
  status: null,
  periodEnd: null,
  exp: null,
  comp: false,
  entitlementValid: false,
  lastCheckedAt: null,
  offline: false,
  deviceName: null,
  lastKnownPlan: null,
  team: null,
};

const PRO: AccountInfo = {
  ...SIGNED_OUT,
  signedIn: true,
  login: "octocat",
  sub: "1234567",
  plan: "pro",
  exp: Date.UTC(2027, 0, 1),
  entitlementValid: true,
  lastCheckedAt: 1,
  deviceName: "Test Mac",
};

describe("accountStore", () => {
  it("loads, then follows account://changed", async () => {
    const stub = tauri();
    stub.fixture("account_get", SIGNED_OUT);
    stub.fixture("account_dev_skip_sign_in", false);
    await startAccountListeners();
    expect(useAccount.getState().info).toEqual(SIGNED_OUT);
    expect(useAccount.getState().loaded).toBe(true);

    stub.emit("account://changed", { ...SIGNED_OUT, lastCheckedAt: 7 });
    expect(useAccount.getState().info?.lastCheckedAt).toBe(7);
  });

  it("runs a sign-in from code to signed in", async () => {
    const stub = tauri();
    stub.fixture("account_get", SIGNED_OUT);
    stub.fixture("account_dev_skip_sign_in", false);
    stub.fixture("account_sign_in_start", {
      attempt: 1,
      userCode: "ABCD-1234",
      verificationUri: "https://github.com/login/device",
      expiresIn: 900,
    });
    await startAccountListeners();
    const start = await useAccount.getState().signInStart();
    expect(start?.userCode).toBe("ABCD-1234");
    expect(useAccount.getState().signIn?.verificationUri).toBe("https://github.com/login/device");

    stub.emit("account://sign-in", { attempt: 1, state: "waiting", intervalSecs: 5 });
    expect(useAccount.getState().progress).toEqual({ state: "waiting", intervalSecs: 5 });

    stub.emit("account://sign-in", { attempt: 1, state: "signed_in", info: PRO });
    const s = useAccount.getState();
    expect(s.info).toEqual(PRO);
    expect(s.signIn).toBeNull();
    expect(currentPlan(s.info)).toBe("pro");
  });

  it("keeps the backend's typed error when a sign-in fails", async () => {
    const stub = tauri();
    stub.fixture("account_get", SIGNED_OUT);
    stub.fixture("account_dev_skip_sign_in", false);
    stub.fixture("account_sign_in_start", () => {
      throw { code: "not_configured", message: "This build of Plyloft can't sign in to GitHub yet." };
    });
    await startAccountListeners();
    expect(await useAccount.getState().signInStart()).toBeNull();
    expect(useAccount.getState().error?.code).toBe("not_configured");

    stub.emit("account://sign-in", {
      attempt: 1,
      state: "failed",
      error: { code: "access_denied", message: "The sign-in was declined on GitHub." },
    });
    expect(useAccount.getState().error?.code).toBe("access_denied");
  });

  it("drops a superseded sign-in's late events", async () => {
    const stub = tauri();
    stub.fixture("account_get", SIGNED_OUT);
    stub.fixture("account_dev_skip_sign_in", false);
    let next = 0;
    stub.fixture("account_sign_in_start", () => ({
      attempt: ++next,
      userCode: `CODE-${next}`,
      verificationUri: "https://github.com/login/device",
      expiresIn: 900,
    }));
    await startAccountListeners();
    await useAccount.getState().signInStart();
    await useAccount.getState().signInStart();
    expect(useAccount.getState().signIn?.userCode).toBe("CODE-2");

    // The first attempt, cancelled by the second, reports late.
    stub.emit("account://sign-in", { attempt: 1, state: "cancelled" });
    stub.emit("account://sign-in", {
      attempt: 1,
      state: "failed",
      error: { code: "cancelled", message: "Sign-in cancelled." },
    });
    expect(useAccount.getState().signIn?.userCode).toBe("CODE-2");
    expect(useAccount.getState().error).toBeNull();

    stub.emit("account://sign-in", { attempt: 2, state: "waiting", intervalSecs: 5 });
    expect(useAccount.getState().progress).toEqual({ state: "waiting", intervalSecs: 5 });
  });

  it("keeps a refused cancel as an error instead of throwing", async () => {
    const stub = tauri();
    stub.fixture("account_sign_in_cancel", () => {
      throw "backend gone";
    });
    await useAccount.getState().signInCancel();
    expect(useAccount.getState().error).toEqual({ code: "internal", message: "backend gone" });
  });

  it("refresh and sign-out replace the info", async () => {
    const stub = tauri();
    stub.fixture("account_refresh", { ...PRO, offline: true });
    stub.fixture("account_sign_out", SIGNED_OUT);
    await useAccount.getState().refresh();
    expect(useAccount.getState().info?.offline).toBe(true);
    await useAccount.getState().signOut();
    expect(useAccount.getState().info).toEqual(SIGNED_OUT);
    expect(stub.callsOf("account_sign_out")).toHaveLength(1);
  });

  it("A2: loads the debug-only sign-in skip with the account, and reads a refusal as no skip", async () => {
    const stub = tauri();
    stub.fixture("account_get", SIGNED_OUT);
    stub.fixture("account_dev_skip_sign_in", true);
    await startAccountListeners();
    expect(useAccount.getState().devSkip).toBe(true);
    // The skip is no account: signed out still.
    expect(accountReady(useAccount.getState().info)).toBe(false);

    stub.fixture("account_dev_skip_sign_in", () => {
      throw "no such command";
    });
    await useAccount.getState().load();
    expect(useAccount.getState().devSkip).toBe(false);
  });

  it("A3: signed out covers nothing — key listeners answer as with no Setup", async () => {
    const stub = tauri();
    stub.fixture("account_get", SIGNED_OUT);
    stub.fixture("account_dev_skip_sign_in", false);
    act(() => useSetup.setState({ open: false }));
    await startAccountListeners();
    expect(useAccount.getState().loaded).toBe(true);
    expect(accountReady(useAccount.getState().info)).toBe(false);
    // Shortcuts and the tutorial follow `setupIsOpen()`: only Setup counts.
    expect(setupIsOpen()).toBe(false);
    act(() => useAccount.setState({ info: null }));
    expect(setupIsOpen()).toBe(false);
    act(() => useSetup.setState({ open: true }));
    expect(setupIsOpen()).toBe(true);
    act(() => useSetup.setState({ open: false }));
  });

  it("accountReady: a signed-in account, whatever its entitlement", () => {
    expect(accountReady(null)).toBe(false);
    expect(accountReady(SIGNED_OUT)).toBe(false);
    expect(accountReady(PRO)).toBe(true);
    // QoL 1.168 (owner D1, D2): a plan that ran out offline is Free, still signed in.
    expect(accountReady({ ...PRO, entitlementValid: false })).toBe(true);
    expect(accountReady({ ...PRO, signedIn: false })).toBe(false);
  });

  it("A3: Use Team on this computer puts the new account in the store and reads the gates again", async () => {
    const stub = tauri();
    const TEAM_HERE: AccountInfo = {
      ...PRO,
      plan: "team",
      teamRepo: "acme/team",
      teamRole: "member",
      lastKnownPlan: "team",
      team: { state: "here", device: null, teamRepo: "acme/team", role: "member" },
    };
    stub.fixture("account_use_team", TEAM_HERE);
    stub.fixture("plan_gates_get", null);
    act(() => useAccount.setState({ info: { ...PRO, plan: "free" }, loaded: true, error: null }));
    const pending = useAccount.getState().useTeam();
    expect(useAccount.getState().movingTeam).toBe(true);
    // A second press while it runs sends nothing more.
    expect(await useAccount.getState().useTeam()).toBeNull();
    expect(await pending).toEqual(TEAM_HERE);
    const s = useAccount.getState();
    expect(s.info).toEqual(TEAM_HERE);
    expect(s.movingTeam).toBe(false);
    expect(stub.callsOf("account_use_team")).toHaveLength(1);
    expect(stub.callsOf("plan_gates_get").length).toBeGreaterThan(0);
  });

  it("A3: a refused Use Team keeps the error, reads the account again and resolves null", async () => {
    const stub = tauri();
    stub.fixture("account_use_team", () => {
      throw { code: "rate_limited", message: "Team moved between computers too often today." };
    });
    stub.fixture("account_get", SIGNED_OUT);
    act(() => useAccount.setState({ info: PRO, loaded: true, error: null }));
    expect(await useAccount.getState().useTeam()).toBeNull();
    const s = useAccount.getState();
    expect(s.error?.code).toBe("rate_limited");
    expect(s.movingTeam).toBe(false);
    expect(s.info).toEqual(SIGNED_OUT);
  });

  it("reads a plan without a valid entitlement as free", () => {
    expect(currentPlan(null)).toBe("free");
    expect(currentPlan({ ...PRO, entitlementValid: false })).toBe("free");
  });
});

// 1.178.0 (A3, D24): the server ended this computer's session (`unauthorized`,
// e.g. Sign out other computers pressed elsewhere): signed out silently; the
// toast only on a computer that follows a team, and once.
describe("a session the server ended", () => {
  const titles = () => useToasts.getState().toasts.map((t) => t.title);
  const SIGNED_OUT_TOAST = "Signed out of Plyloft on this Mac";
  const follow = (teamRepo: string | null) =>
    act(() =>
      useSettings.setState({
        settings: { ...DEFAULT_SETTINGS, team: { ...DEFAULT_SETTINGS.team, teamRepo } },
        loaded: true,
      }),
    );
  async function signedInWithListeners() {
    const stub = tauri();
    stub.fixture("account_get", PRO);
    stub.fixture("account_dev_skip_sign_in", false);
    await startAccountListeners();
    expect(useAccount.getState().info?.signedIn).toBe(true);
    return stub;
  }

  it("on a computer that follows a team: one toast, signed out, nothing else", async () => {
    follow("acme/team");
    const stub = await signedInWithListeners();
    act(() => stub.emit("account://changed", SIGNED_OUT));
    expect(useAccount.getState().info?.signedIn).toBe(false);
    const toast = useToasts.getState().toasts.find((t) => t.title === SIGNED_OUT_TOAST);
    expect(toast?.body).toBe(
      "Sign in again to use Team features on this computer.",
    );
    // The next refresh ticks while signed out say nothing more.
    act(() => stub.emit("account://changed", { ...SIGNED_OUT, lastCheckedAt: 9 }));
    expect(titles().filter((t) => t === SIGNED_OUT_TOAST)).toHaveLength(1);
  });

  it("a refresh's own answer counts the same way", async () => {
    follow("acme/team");
    const stub = await signedInWithListeners();
    stub.fixture("account_refresh", SIGNED_OUT);
    await useAccount.getState().refresh();
    expect(titles()).toContain(SIGNED_OUT_TOAST);
  });

  it("on a computer that follows no team: silent", async () => {
    follow(null);
    const stub = await signedInWithListeners();
    act(() => stub.emit("account://changed", SIGNED_OUT));
    expect(useAccount.getState().info?.signedIn).toBe(false);
    expect(titles()).not.toContain(SIGNED_OUT_TOAST);
  });

  it("this computer's own Sign out: no toast", async () => {
    follow("acme/team");
    const stub = await signedInWithListeners();
    stub.fixture("account_sign_out", () => {
      // The backend's own `account://changed` lands before the answer.
      stub.emit("account://changed", SIGNED_OUT);
      return SIGNED_OUT;
    });
    await useAccount.getState().signOut();
    expect(useAccount.getState().info?.signedIn).toBe(false);
    expect(titles()).not.toContain(SIGNED_OUT_TOAST);
  });
});
