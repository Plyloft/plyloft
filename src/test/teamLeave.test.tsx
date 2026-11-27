// 1.175.0 D5 (review SRV-2; owner D5-a, D5-b): Leave this team for a member
// who holds a seat — one action, the seat first and this Mac after; nothing
// changes when Plyloft's account can't be reached; and the owner, or a member
// without a seat, keeps the row and the sheet they had.
import { describe, expect, it, vi } from "vitest";
import { LeaveTeam } from "../components/settings/TeamPage";
import type { AccountInfo } from "../ipc";
import { useAccount } from "../store/accountStore";
import { setPlatformForTests } from "../lib/platform";
import { act, nextFrame, renderUi, screen, waitFor, within } from "./render";

const TEAM = "mbadv/plyloft-team";
const MEMBER: AccountInfo = {
  signedIn: true,
  login: "test-user",
  sub: "7",
  plan: "team",
  teamRepo: TEAM,
  teamRole: "member",
  status: "active",
  periodEnd: null,
  exp: Date.UTC(2099, 0, 1),
  comp: false,
  entitlementValid: true,
  lastCheckedAt: Date.UTC(2026, 10, 9),
  offline: false,
  lastKnownPlan: "free",
  team: null,
  deviceName: "Mac mini",
};

function show(info: AccountInfo, fixtures: Record<string, unknown> = {}) {
  act(() => useAccount.setState({ loaded: true, info }));
  const onLeft = vi.fn();
  const r = renderUi(<LeaveTeam teamRepo={TEAM} ownerLogin="test-owner" onLeft={onLeft} />, { fixtures, withToasts: true });
  r.tauri.allowUnhandled();
  return { ...r, onLeft };
}

describe("Leave this team, for a member who holds a seat", () => {
  it("says the seat first on the row, and opens the sheet with what is lost and what stays", async () => {
    const { user, tauri } = show(MEMBER);
    expect(
      screen.getByText(
        "You give up your seat on mbadv/plyloft-team's Team plan, and this Mac stops following the team. Its clones and the team workspaces stay on this Mac, and nothing changes on GitHub.",
      ),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Leave…" }));
    const sheet = await screen.findByRole("dialog", { name: "Leave mbadv/plyloft-team?" });
    expect(sheet.textContent).toContain(
      "You give up your seat on its Team plan, on every computer you use, and this Mac stops following the team.",
    );
    expect(within(sheet).getByText("What you lose")).toBeTruthy();
    expect(within(sheet).getByText("What stays")).toBeTruthy();
    expect(
      within(sheet).getByText("Your seat: test-owner can give it to someone else. Coming back needs a seat from them."),
    ).toBeTruthy();
    expect(
      within(sheet).getByText(
        "Nothing changes on GitHub: your access to the repositories, your issues and your pull requests stay until test-owner removes you.",
      ),
    ).toBeTruthy();
    // The same two buttons, the focus on the safe one; nothing sent yet.
    expect(within(sheet).getAllByRole("button").map((b) => b.textContent)).toEqual(["Cancel", "Leave the team"]);
    await nextFrame();
    expect(document.activeElement).toBe(within(sheet).getByRole("button", { name: "Cancel" }));
    expect(tauri.callsOf("team_leave_seat")).toHaveLength(0);
  });

  it("frees the seat and leaves in one press, and never calls the local-only leave", async () => {
    const { user, tauri, onLeft } = show(MEMBER, { team_leave_seat: () => ({ left: true, local: true }) });
    await user.click(screen.getByRole("button", { name: "Leave…" }));
    await user.click(await screen.findByRole("button", { name: "Leave the team" }));
    expect(await screen.findByText(/^You left mbadv\/plyloft-team\.?$/)).toBeTruthy();
    expect(
      screen.getByText(
        "Your seat is free, and this Mac no longer follows the team. Its workspaces and clones are still here. Join or create a team whenever you like.",
      ),
    ).toBeTruthy();
    expect(tauri.callsOf("team_leave_seat")).toHaveLength(1);
    expect(tauri.callsOf("team_leave")).toHaveLength(0);
    expect(onLeft).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says a seat that was already free, and one freed while this Mac couldn't save", async () => {
    const free = show(MEMBER, { team_leave_seat: () => ({ left: false, local: true }) });
    await free.user.click(screen.getByRole("button", { name: "Leave…" }));
    await free.user.click(await screen.findByRole("button", { name: "Leave the team" }));
    expect(await screen.findByText(/^Your seat was already free, and this Mac no longer follows the team\./)).toBeTruthy();
    free.unmount();
    const half = show(MEMBER, { team_leave_seat: () => ({ left: true, local: false }) });
    await half.user.click(screen.getByRole("button", { name: "Leave…" }));
    await half.user.click(await screen.findByRole("button", { name: "Leave the team" }));
    expect(await screen.findByText(/^Your seat is free, but this Mac still follows the team\.?$/)).toBeTruthy();
    expect(screen.getByText("Plyloft couldn't save that here. Press Leave again; it is safe.")).toBeTruthy();
  });

  it("keeps the sheet open with the reason when the account can't be reached, and nothing changes", async () => {
    const { user, tauri, onLeft } = show(MEMBER, {
      team_leave_seat: () => Promise.reject({ kind: "offline", message: "connection refused" }),
    });
    await user.click(screen.getByRole("button", { name: "Leave…" }));
    await user.click(await screen.findByRole("button", { name: "Leave the team" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "Couldn't leave the team Plyloft couldn't reach your Plyloft account, so your seat is still yours and nothing changed on this Mac. Check the connection and try again.",
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(onLeft).not.toHaveBeenCalled();
    expect(tauri.callsOf("team_leave")).toHaveLength(0);
    // The buttons are back: Cancel leaves everything as it was.
    await waitFor(() => expect((screen.getByRole("button", { name: "Leave the team" }) as HTMLButtonElement).disabled).toBe(false));
  });

  it("a server that doesn't know the route is a failure, never an already free seat", async () => {
    const { user, onLeft } = show(MEMBER, {
      team_leave_seat: () => Promise.reject({ kind: "unsupported", message: "Not found." }),
    });
    await user.click(screen.getByRole("button", { name: "Leave…" }));
    await user.click(await screen.findByRole("button", { name: "Leave the team" }));
    expect((await screen.findByRole("alert")).textContent).toContain("so your seat is still yours and nothing changed on this Mac.");
    expect(screen.queryByText(/already free/)).toBeNull();
    expect(onLeft).not.toHaveBeenCalled();
  });

  it("is off while offline, and says why", () => {
    show({ ...MEMBER, offline: true });
    expect(screen.getByText(/Can't be done while offline — Plyloft needs your Plyloft account\.$/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Leave…" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("says this PC on Windows", async () => {
    setPlatformForTests("windows");
    const { user } = show(MEMBER);
    expect(screen.getByText(/and this PC stops following the team\. Its clones and the team workspaces stay on this PC/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Leave…" }));
    const sheet = await screen.findByRole("dialog");
    expect(sheet.textContent).toContain("and this PC stops following the team.");
    expect(sheet.textContent).toContain("every team workspace stay on this PC exactly as they are.");
    expect(sheet.textContent).not.toContain("this Mac");
  });
});

describe("Leave this team, for the owner or a member without a seat", () => {
  const TODAY = "This Mac stops following the team. Its clones and the team workspaces stay on this Mac, and nothing changes on GitHub.";

  it("keeps today's row, sheet and press", async () => {
    for (const info of [
      { ...MEMBER, teamRole: "owner" as const },
      { ...MEMBER, plan: "free" as const, teamRole: null, teamRepo: null },
      { ...MEMBER, comp: true },
      { ...MEMBER, offline: true, teamRole: "owner" as const },
    ]) {
      const { user, tauri, unmount } = show(info, { team_leave: () => ({}) });
      const before = tauri.callsOf("team_leave").length;
      expect(screen.getByText(TODAY)).toBeTruthy();
      const leave = screen.getByRole("button", { name: "Leave" }) as HTMLButtonElement;
      expect(leave.disabled).toBe(false);
      await user.click(leave);
      const sheet = await screen.findByRole("dialog", { name: "Leave mbadv/plyloft-team?" });
      expect(sheet.textContent).toContain("This Mac stops following the team: its members, workspaces and library no longer show here.");
      expect(within(sheet).queryByText("What you lose")).toBeNull();
      await user.click(within(sheet).getByRole("button", { name: "Leave the team" }));
      await waitFor(() => expect(tauri.callsOf("team_leave")).toHaveLength(before + 1));
      expect(tauri.callsOf("team_leave_seat")).toHaveLength(0);
      unmount();
    }
  });
});
