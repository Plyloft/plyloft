// Launch A2 (LAUNCH_PLAN D1, D2): the sign-in's states, rendered and driven
// the way the backend drives them — `account_sign_in_start` answers the code,
// `account://sign-in` reports the progress, `account://changed` moves the
// account. 1.178.0 (A3): there is no full-window Sign-in screen; the flow is
// `SignInBody`, drawn here inside Setup's step 2 (`AccountStep`) and as the
// Plan page, Create team and the joined team's notice embed it. The step's
// frame (lede, footer, Skipped) is setupOverlay.test.tsx's.
import { describe, expect, it, vi } from "vitest";
import { AccountStep, SignInBody, useSignInFlow, type SignInFlowOptions } from "../components/setup/SignInStep";
import { PlanPage } from "../components/settings/PlanPage";
import { startAccountListeners, useAccount } from "../store/accountStore";
import type { AccountInfo, SignInStart } from "../ipc";
import { act, renderUi, screen, waitFor, within } from "./render";

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
const SIGNED_IN: AccountInfo = {
  ...SIGNED_OUT,
  signedIn: true,
  login: "octocat",
  sub: "1",
  exp: Date.UTC(2099, 0, 1),
  entitlementValid: true,
  lastCheckedAt: 1,
  deviceName: "Test Mac",
  lastKnownPlan: "free",
};
const CODE: SignInStart = {
  attempt: 1,
  userCode: "WDJB-MJHT",
  verificationUri: "https://github.com/login/device",
  expiresIn: 900,
};

/** An embedder's frame (Plan page, Create team, the team notice): its own
 *  flow, the body's bordered button, the sign-in's end through onSignedIn. */
function Embedded({ action, onSignedIn }: { action?: boolean; onSignedIn?: SignInFlowOptions["onSignedIn"] }) {
  const flow = useSignInFlow({ onSignedIn });
  return (
    <div data-testid="frame">
      {action === false && flow.view.primary && (
        <button type="button" onClick={() => void flow.run(flow.view.primary!.action)}>
          Row: {flow.view.primary.label}
        </button>
      )}
      <SignInBody flow={flow} action={action} />
    </div>
  );
}

async function show(account: AccountInfo = SIGNED_OUT, start: unknown = CODE, ui = <AccountStep />) {
  const r = renderUi(ui, {
    withToasts: true,
    fixtures: {
      account_get: account,
      account_dev_skip_sign_in: false,
      account_sign_in_start: typeof start === "function" ? start : () => start,
      account_sign_in_cancel: null,
      account_refresh: account,
      setup_open_page: null,
    },
  });
  await act(async () => {
    await startAccountListeners();
  });
  return r;
}

const status = () => document.querySelector(".ux-status-text")?.textContent ?? null;
const button = (name: string | RegExp) => screen.getByRole("button", { name });

describe("Sign in to Plyloft, in Setup's step 2", () => {
  it("says what the account is, in plain words, before anything starts", async () => {
    const { container } = await show();
    expect(container.textContent).toContain(
      "Sign in to Plyloft with GitHub to start or join a team. This sign-in identifies your GitHub account and grants no access to your repositories.",
    );
    // D1: not the next step's GitHub sign-in.
    expect(container.textContent).toContain("This is separate from GitHub for your projects, the next step");
    // Bordered, never filled: signing in is optional.
    expect(button("Sign in with GitHub").classList.contains("cbtn--accent")).toBe(false);
    expect(button("No GitHub account? Create one")).toBeTruthy();
    expect(container.querySelectorAll(".cbtn--accent")).toHaveLength(0);
  });

  it("pending: the code big, Copy, the device page, and Cancel", async () => {
    const { user, tauri } = await show();
    await user.click(button("Sign in with GitHub"));
    expect(tauri.callsOf("account_sign_in_start")).toHaveLength(1);
    expect(await screen.findByText("WDJB-MJHT")).toBeTruthy();
    expect(status()).toBe("Waiting for you to enter the code on GitHub.");
    // One way forward at a time: no primary while GitHub waits.
    expect(screen.queryByRole("button", { name: "Sign in with GitHub" })).toBeNull();

    await user.click(button("Copy code"));
    expect(await navigator.clipboard.readText()).toBe("WDJB-MJHT");
    expect(await screen.findByText("Code copied.")).toBeTruthy();

    await user.click(button("Open github.com/login/device"));
    expect(tauri.callsOf("setup_open_page").map((c) => c.args.page)).toEqual(["github-device"]);

    act(() => tauri.emit("account://sign-in", { attempt: 1, state: "waiting", intervalSecs: 5 }));
    expect(status()).toBe("Waiting for you to enter the code on GitHub.");
    act(() => tauri.emit("account://sign-in", { attempt: 1, state: "verifying" }));
    expect(status()).toBe("GitHub said yes. Plyloft is checking your account…");

    await user.click(button("Cancel"));
    expect(tauri.callsOf("account_sign_in_cancel")).toHaveLength(1);
    await waitFor(() => expect(screen.queryByText("WDJB-MJHT")).toBeNull());
    expect(button("Sign in with GitHub")).toBeTruthy();
  });

  it("N14 F1: the code centred with room, Open the device page the one primary, Copy code beside it, the status after", async () => {
    const { user } = await show();
    await user.click(button("Sign in with GitHub"));
    const value = await screen.findByText("WDJB-MJHT");
    const block = value.closest(".ux-signin-code") as HTMLElement;
    expect(block).toBeTruthy();
    expect(value.classList.contains("ux-signin-code-value")).toBe(true);
    // The code first, then its two buttons in one row: Copy code, then the page.
    const actions = block.querySelector(".ux-signin-code-actions") as HTMLElement;
    expect(value.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const buttons = within(actions).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["Copy code", "Open github.com/login/device"]);
    expect(buttons[0].classList.contains("cbtn--strong")).toBe(true);
    expect(buttons[1].classList.contains("cbtn--accent")).toBe(true);
    // The body's only accent while GitHub waits (Setup's Continue steps aside).
    expect(Array.from(document.querySelectorAll(".cbtn--accent"))).toEqual([buttons[1]]);
    // The status line comes after the block, outside it.
    const line = document.querySelector(".ux-status-text") as HTMLElement;
    expect(block.contains(line)).toBe(false);
    expect(block.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("slow down: still waiting, in words", async () => {
    const { user, tauri } = await show();
    await user.click(button("Sign in with GitHub"));
    await screen.findByText("WDJB-MJHT");
    act(() => tauri.emit("account://sign-in", { attempt: 1, state: "slow_down", intervalSecs: 10 }));
    expect(status()).toBe("GitHub asked Plyloft to check less often. Still waiting for the code.");
    expect(screen.getByText("WDJB-MJHT")).toBeTruthy();
  });

  it("expired: says so and gets a new code", async () => {
    let n = 0;
    const { user, tauri } = await show(SIGNED_OUT, () => ({ ...CODE, attempt: ++n, userCode: `CODE-${n}` }));
    await user.click(button("Sign in with GitHub"));
    await screen.findByText("CODE-1");
    act(() =>
      tauri.emit("account://sign-in", {
        attempt: 1,
        state: "failed",
        error: { code: "expired_token", message: "The code expired." },
      }),
    );
    expect(status()).toBe("The code expired before it was entered on GitHub.");
    expect(screen.queryByText("CODE-1")).toBeNull();
    await user.click(button("Get a new code"));
    expect(await screen.findByText("CODE-2")).toBeTruthy();
    expect(tauri.callsOf("account_sign_in_start")).toHaveLength(2);
  });

  it("denied: nothing was shared, and Try again", async () => {
    const { user, tauri } = await show();
    await user.click(button("Sign in with GitHub"));
    await screen.findByText("WDJB-MJHT");
    act(() =>
      tauri.emit("account://sign-in", {
        attempt: 1,
        state: "failed",
        error: { code: "access_denied", message: "Declined." },
      }),
    );
    expect(status()).toBe("The sign-in was turned down on GitHub. Nothing was shared with Plyloft.");
    expect(button("Try again")).toBeTruthy();
  });

  it("offline (D4): one plain network line, first launch or not; Try again", async () => {
    const NETWORK = "Plyloft couldn't reach GitHub or the Plyloft server. Check your connection and try again.";
    let online = false;
    const { user } = await show(SIGNED_OUT, () => {
      if (!online) throw { code: "network", message: "offline" };
      return CODE;
    });
    await user.click(button("Sign in with GitHub"));
    expect(await screen.findByText(NETWORK)).toBeTruthy();
    expect(screen.queryByText(/needs an internet connection once/)).toBeNull();
    // Try again: bordered, in the body.
    expect(button("Try again").classList.contains("cbtn--accent")).toBe(false);
    online = true;
    await user.click(button("Try again"));
    expect(await screen.findByText("WDJB-MJHT")).toBeTruthy();
  });

  it("offline later (signed in before): the same line", async () => {
    const { user } = await show({ ...SIGNED_OUT, lastCheckedAt: 5 }, () => {
      throw { code: "network", message: "offline" };
    });
    await user.click(button("Sign in with GitHub"));
    expect(await screen.findByText("Plyloft couldn't reach GitHub or the Plyloft server. Check your connection and try again.")).toBeTruthy();
  });

  it("not configured: this copy can't sign in yet", async () => {
    const { user } = await show(SIGNED_OUT, () => {
      throw { code: "not_configured", message: "no client id" };
    });
    await user.click(button("Sign in with GitHub"));
    expect(await screen.findByText(/Sign-in isn't set up in this copy of Plyloft yet/)).toBeTruthy();
  });

  it("success: signed in as the login and the plan", async () => {
    const { user, tauri } = await show();
    await user.click(button("Sign in with GitHub"));
    await screen.findByText("WDJB-MJHT");
    act(() => tauri.emit("account://sign-in", { attempt: 1, state: "signed_in", info: { ...SIGNED_IN, plan: "team" } }));
    expect(status()).toBe("Signed in as octocat · Team");
    expect(useAccount.getState().info?.entitlementValid).toBe(true);
    expect(screen.queryByText("WDJB-MJHT")).toBeNull();
  });

  it("A3 (D5): signed out after a sign-in elsewhere is the ordinary start, and signing in signs nobody out", async () => {
    // An old file's account, signed out (a 1.177 "replaced" profile).
    const { user, tauri } = await show({ ...SIGNED_OUT, lastCheckedAt: 5 });
    tauri.fixture("account_sign_out_others", 1);
    expect(screen.queryByText(/Your plan moved to/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign in and sign out the other computers" })).toBeNull();
    await user.click(button("Sign in with GitHub"));
    await screen.findByText("WDJB-MJHT");
    act(() => tauri.emit("account://sign-in", { attempt: 1, state: "signed_in", info: SIGNED_IN }));
    await waitFor(() => expect(useAccount.getState().info?.signedIn).toBe(true));
    expect(tauri.callsOf("account_sign_out_others")).toHaveLength(0);
  });

  it("QoL 12.2: signed in with a plan too old to use offline is done (Free), not a check view", async () => {
    const stale: AccountInfo = { ...SIGNED_IN, entitlementValid: false, exp: null, offline: true, lastCheckedAt: Date.UTC(2026, 8, 1) };
    await show(stale);
    expect(status()).toBe("Signed in as octocat · Free");
    expect(screen.queryByRole("button", { name: "Look again" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign in with GitHub" })).toBeNull();
  });

  it("no GitHub account (D2): opens GitHub's sign-up and says to come back", async () => {
    const { user, tauri } = await show();
    await user.click(button("No GitHub account? Create one"));
    expect(tauri.callsOf("setup_open_page").map((c) => c.args.page)).toEqual(["github-signup"]);
    expect(screen.getByText(/Create your account there, then come back here and choose Sign in with GitHub/)).toBeTruthy();
  });

  it("a dev build that skips sign-in: the note in place of the button", async () => {
    const { container } = await show();
    act(() => useAccount.setState({ devSkip: true }));
    expect(await screen.findByText("Sign-in is skipped in this development build. Plans read as Free.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign in with GitHub" })).toBeNull();
    expect(screen.queryByRole("button", { name: "No GitHub account? Create one" })).toBeNull();
    expect(container.textContent).toContain("Sign in to Plyloft with GitHub to start or join a team.");
  });
});

// The embedders' contract (Plan page, Create team's sign_in stage, the
// joined team's notice): `SignInBody` with its own flow.
describe("SignInBody, embedded", () => {
  it("draws the bordered button itself, no Setup words, and tells the frame once the sign-in finished", async () => {
    const onSignedIn = vi.fn();
    const { user, tauri, container } = await show(SIGNED_OUT, CODE, <Embedded onSignedIn={onSignedIn} />);
    expect(container.textContent).not.toContain("This is separate from GitHub for your projects");
    expect(container.textContent).not.toContain("Sign in to Plyloft with GitHub to start or join a team.");
    expect(container.querySelectorAll(".cbtn--accent")).toHaveLength(0);
    await user.click(button("Sign in with GitHub"));
    expect(tauri.callsOf("account_sign_in_start")).toHaveLength(1);
    await screen.findByText("WDJB-MJHT");
    expect(onSignedIn).not.toHaveBeenCalled();
    act(() => tauri.emit("account://sign-in", { attempt: 1, state: "signed_in", info: SIGNED_IN }));
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
    expect(onSignedIn.mock.calls[0][0].login).toBe("octocat");
    expect(status()).toBe("Signed in as octocat · Free");
    // A later account update calls nothing more.
    act(() => tauri.emit("account://changed", { ...SIGNED_IN, lastCheckedAt: 9 }));
    expect(onSignedIn).toHaveBeenCalledTimes(1);
  });

  it("action={false}: the frame's own button runs the same flow, the body shows the code and the end", async () => {
    const { user, tauri } = await show(SIGNED_OUT, CODE, <Embedded action={false} />);
    expect(screen.queryByRole("button", { name: "Sign in with GitHub" })).toBeNull();
    await user.click(button("Row: Sign in with GitHub"));
    expect(tauri.callsOf("account_sign_in_start")).toHaveLength(1);
    expect(await screen.findByText("WDJB-MJHT")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Row:/ })).toBeNull();
    await user.click(button("Cancel"));
    await waitFor(() => expect(screen.queryByText("WDJB-MJHT")).toBeNull());
    expect(button("Row: Sign in with GitHub")).toBeTruthy();
  });

  it("an account already signed in calls nothing, and draws only the status line", async () => {
    const onSignedIn = vi.fn();
    await show(SIGNED_IN, CODE, <Embedded onSignedIn={onSignedIn} />);
    expect(status()).toBe("Signed in as octocat · Free");
    expect(screen.queryByRole("button")).toBeNull();
    expect(onSignedIn).not.toHaveBeenCalled();
  });
});

describe("Settings › Setup and account › Plan › Plyloft account (A2's row, on A3's page)", () => {
  it("shows the login; Sign out asks first, then signs out, and the row offers Sign in again", async () => {
    act(() => useAccount.setState({ loaded: true, info: SIGNED_IN }));
    const { user, tauri } = renderUi(<PlanPage scope="this-mac" />, {
      fixtures: { account_sign_out: SIGNED_OUT },
    });
    expect(screen.getByText("octocat")).toBeTruthy();
    expect(screen.getAllByText("Free").length).toBeGreaterThan(0);
    // D10.
    expect(
      screen.getByText(
        "Your GitHub sign-in, used only to start or join a team. This is separate from the GitHub accounts Plyloft uses for pull requests.",
      ),
    ).toBeTruthy();
    // Cancel keeps the account.
    await user.click(button("Sign out"));
    const ask = await screen.findByRole("dialog", { name: "Sign out of Plyloft?" });
    // D11.
    expect(ask.textContent).toContain(
      "Everything for one person keeps working. Team features turn off on this Mac until you sign in again.",
    );
    await user.click(within(ask).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Sign out of Plyloft?" })).toBeNull());
    expect(tauri.callsOf("account_sign_out")).toHaveLength(0);
    // Confirm signs out.
    await user.click(button("Sign out"));
    const sheet = await screen.findByRole("dialog", { name: "Sign out of Plyloft?" });
    await user.click(within(sheet).getByRole("button", { name: "Sign out" }));
    expect(tauri.callsOf("account_sign_out")).toHaveLength(1);
    // D9: not signed in, with Sign in with GitHub on the row; no cover.
    await waitFor(() => expect(screen.getByText("not signed in")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
    expect(button("Sign in with GitHub")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

