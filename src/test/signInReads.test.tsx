// 1.172.0 B2: after a GitHub sign-in the cards that said "sign in again" are
// read at once — when a new sign-in is read, and when Settings closes — not
// on the poller's next look.
import { afterEach, describe, expect, it } from "vitest";
import { newSignIn, startSignInReads } from "../store/signInReads";
import { useGithubStatus } from "../store/githubStatusStore";
import { useUi } from "../store/uiStore";
import type { GithubStatus } from "../ipc";
import { act, renderUi, tauri } from "./render";

function status(...signedIn: string[]): GithubStatus {
  return {
    ghFound: true,
    accounts: signedIn.map((login) => ({ login, active: true, state: "signed-in", scopes: null })),
    helper: "gh",
    githubEmail: null,
    githubNoreply: null,
    sso: null,
  };
}

describe("reads after a sign-in", () => {
  let stop: (() => void) | null = null;
  afterEach(() => {
    stop?.();
    stop = null;
    act(() => {
      useGithubStatus.setState({ status: null });
      useUi.getState().setSettingsOverlayOpen(false);
    });
  });

  it("a new signed-in account is a sign-in; the first read and a sign-out are not", () => {
    expect(newSignIn(null, status("a"))).toBe(false);
    expect(newSignIn(status(), status("a"))).toBe(true);
    expect(newSignIn(status("a"), status("a", "b"))).toBe(true);
    expect(newSignIn(status("a"), status("a"))).toBe(false);
    expect(newSignIn(status("a", "b"), status("a"))).toBe(false);
    const refused = { ...status(), accounts: [{ login: "a", active: true, state: "refused" as const, scopes: null }] };
    expect(newSignIn(status(), refused)).toBe(false);
  });

  it("reads again when Settings closes and when a sign-in is read", async () => {
    renderUi(<div />, { fixtures: { pr_read_signed_out_again: 1 } });
    stop = startSignInReads();
    const calls = () => tauri().callsOf("pr_read_signed_out_again").length;
    act(() => useUi.getState().setSettingsOverlayOpen(true));
    expect(calls()).toBe(0);
    act(() => useUi.getState().setSettingsOverlayOpen(false));
    expect(calls()).toBe(1);
    act(() => useGithubStatus.setState({ status: status() }));
    expect(calls()).toBe(1);
    act(() => useGithubStatus.setState({ status: status("octocat") }));
    expect(calls()).toBe(2);
    act(() => useGithubStatus.setState({ status: status("octocat") }));
    expect(calls()).toBe(2);
  });
});
