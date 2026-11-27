// N14 walk F22 (VM, 2026-10-02): Settings › Team › "Read it again" gave no
// feedback after a read that went through ("what should I see?"). While it
// reads, the button is busy ("Reading…", disabled, aria-busy); once a read
// has gone through, a quiet "Read just now" sits beside it. A read that failed
// keeps its own line (F16's status box or the toast) and no success line.
import { afterEach, describe, expect, it, vi } from "vitest";
import { TeamPage } from "../components/settings/TeamPage";
import type { LicenseInfo, TeamStatus } from "../ipc";
import { useLicense } from "../store/licenseStore";
import { act, renderUi, screen, waitFor } from "./render";
import { setTeamAllowed } from "./planGates";

const LICENSE = { status: "valid", team: "Plyloft test team", teamRepo: "boss/team" } as unknown as LicenseInfo;

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
    login: "friend",
    membership: "member",
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

function openPage(refresh: () => TeamStatus | Promise<TeamStatus>) {
  useLicense.setState({ info: LICENSE, loaded: true } as never);
  setTeamAllowed(true);
  return renderUi(<TeamPage scope="team" />, {
    fixtures: {
      team_status: () => memberStatus(),
      team_refresh: refresh,
      team_work_mode: { mode: "team", chosen: true },
      team_member_states: { members: [], problems: [] },
    },
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("N14 walk F22: Read it again says what it did", () => {
  it("is busy while it reads, then says Read just now", async () => {
    let answer: (s: TeamStatus) => void = () => {};
    let held = false;
    const { user } = openPage(() =>
      held ? new Promise<TeamStatus>((resolve) => (answer = resolve)) : memberStatus(),
    );
    // The read on open went through.
    expect(await screen.findByText("Read just now")).toBeTruthy();

    held = true;
    await user.click(screen.getByRole("button", { name: "Read it again" }));
    const busy = await screen.findByRole("button", { name: "Reading…" });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    expect(busy.getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByText("Read just now")).toBeNull();

    answer(memberStatus());
    const again = await screen.findByRole("button", { name: "Read it again" });
    expect((again as HTMLButtonElement).disabled).toBe(false);
    expect(again.getAttribute("aria-busy")).toBeNull();
    expect(await screen.findByText("Read just now")).toBeTruthy();
  });

  it("says nothing of success after a read that came back with an error", async () => {
    openPage(() =>
      memberStatus({ error: "Could not pull the team repo: GitHub didn't answer in time." }),
    );
    expect(
      await screen.findByText("Could not pull the team repo: GitHub didn't answer in time."),
    ).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("button", { name: "Read it again" })).toBeTruthy());
    expect(screen.queryByText(/^Read (just now|\d)/)).toBeNull();
  });

  it("a read answered from the clone says nothing was read, and Members doesn't ask who joined", async () => {
    // `team_refresh` with the pull switched off: a local status, verdict stale.
    const { tauri } = openPage(() => memberStatus({ membershipStale: true }));
    expect(await screen.findByText(/this is the last answer GitHub gave/)).toBeTruthy();
    await waitFor(() => expect(tauri.callsOf("team_refresh").length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.getByRole("button", { name: "Read it again" })).toBeTruthy());
    expect(screen.queryByText(/^Read (just now|\d)/)).toBeNull();
    expect(tauri.callsOf("team_member_states")).toHaveLength(0);
  });

  it("a read that throws says at once that this is the last answer GitHub gave", async () => {
    let fail = false;
    const { user } = openPage(() => {
      if (fail) throw new Error("network down");
      return memberStatus();
    });
    expect(await screen.findByText("Read just now")).toBeTruthy();
    expect(screen.queryByText(/this is the last answer GitHub gave/)).toBeNull();
    fail = true;
    await user.click(screen.getByRole("button", { name: "Read it again" }));
    expect(await screen.findByText(/this is the last answer GitHub gave/)).toBeTruthy();
  });

  describe("while a read from GitHub is under way", () => {
    const LAST_ANSWER = /this is the last answer GitHub gave/;
    // As the backend answers: a local read always calls its verdict stale.
    function openHeld() {
      const answers: { resolve: (s: TeamStatus) => void; reject: (e: Error) => void }[] = [];
      useLicense.setState({ info: LICENSE, loaded: true } as never);
      setTeamAllowed(true);
      const page = renderUi(<TeamPage scope="team" />, {
        fixtures: {
          team_status: () => memberStatus({ membershipStale: true }),
          team_refresh: () => new Promise<TeamStatus>((resolve, reject) => answers.push({ resolve, reject })),
          team_work_mode: { mode: "team", chosen: true },
          team_member_states: { members: [], problems: [] },
        },
      });
      return { ...page, answers };
    }
    const reading = () => screen.findByRole("button", { name: "Reading…" });
    // The page reads twice as it learns the team from its first local read: the newest counts.
    const newest = <T,>(answers: T[]) => answers[answers.length - 1];

    it("the opening read doesn't say so, and a read that goes through never does", async () => {
      const { answers } = openHeld();
      await reading();
      await waitFor(() => expect(screen.getByText(/^Member of/)).toBeTruthy());
      expect(screen.queryByText(LAST_ANSWER)).toBeNull();
      await act(async () => newest(answers).resolve(memberStatus()));
      expect(await screen.findByText("Read just now")).toBeTruthy();
      expect(screen.queryByText(LAST_ANSWER)).toBeNull();
    });

    it("an opening read that throws brings it back", async () => {
      const { answers } = openHeld();
      await reading();
      await waitFor(() => expect(screen.getByText(/^Member of/)).toBeTruthy());
      await act(async () => newest(answers).reject(new Error("network down")));
      expect(await screen.findByText(LAST_ANSWER)).toBeTruthy();
    });

    it("an opening read answered from the clone brings it back", async () => {
      const { answers } = openHeld();
      await reading();
      await waitFor(() => expect(screen.getByText(/^Member of/)).toBeTruthy());
      await act(async () => newest(answers).resolve(memberStatus({ membershipStale: true })));
      expect(await screen.findByText(LAST_ANSWER)).toBeTruthy();
    });

    it("Read it again after a failed read: quiet while it runs, back if that one fails too", async () => {
      const { answers, user } = openHeld();
      await reading();
      await waitFor(() => expect(screen.getByText(/^Member of/)).toBeTruthy());
      await act(async () => newest(answers).reject(new Error("network down")));
      expect(await screen.findByText(LAST_ANSWER)).toBeTruthy();

      const before = answers.length;
      await user.click(screen.getByRole("button", { name: "Read it again" }));
      await reading();
      expect(screen.queryByText(LAST_ANSWER)).toBeNull();
      await waitFor(() => expect(answers.length).toBeGreaterThan(before));
      await act(async () => newest(answers).reject(new Error("network down")));
      expect(await screen.findByText(LAST_ANSWER)).toBeTruthy();
    });
  });

  it("back on a team after another, an answer from before the turn isn't called fresh", async () => {
    let repo = "boss/team";
    const refreshes: (() => TeamStatus | Promise<TeamStatus>)[] = [];
    useLicense.setState({ info: LICENSE, loaded: true } as never);
    setTeamAllowed(true);
    const { user } = renderUi(<TeamPage scope="team" />, {
      fixtures: {
        team_status: () => memberStatus({ teamRepo: repo, membershipStale: true }),
        team_refresh: () => (refreshes.shift() ?? (() => memberStatus({ teamRepo: repo })))(),
        team_work_mode: { mode: "team", chosen: true },
        team_member_states: { members: [], problems: [] },
      },
    });
    expect(await screen.findByText("Read just now")).toBeTruthy();
    repo = "boss/other";
    await user.click(screen.getByRole("button", { name: "Read it again" }));
    await waitFor(() => expect(screen.getByText("boss/other")).toBeTruthy());
    expect(await screen.findByText("Read just now")).toBeTruthy();
    // Back: the press's own read lands, then the turn's read stays out.
    repo = "boss/team";
    let fail: (e: Error) => void = () => {};
    refreshes.push(
      () => memberStatus({ teamRepo: repo }),
      () => new Promise<TeamStatus>((_, reject) => (fail = reject)),
    );
    await user.click(screen.getByRole("button", { name: "Read it again" }));
    await waitFor(() => expect(screen.getByText("boss/team")).toBeTruthy());
    // Quiet while the turn's read runs; if that read fails, nothing fresh is left.
    await screen.findByRole("button", { name: "Reading…" });
    expect(screen.queryByText(/this is the last answer GitHub gave/)).toBeNull();
    await act(async () => fail(new Error("network down")));
    expect(await screen.findByText(/this is the last answer GitHub gave/)).toBeTruthy();
  });

  it("takes the success line away when the next read fails", async () => {
    let fail = false;
    const { user } = openPage(() => {
      if (fail) throw new Error("network down");
      return memberStatus();
    });
    expect(await screen.findByText("Read just now")).toBeTruthy();
    fail = true;
    await user.click(screen.getByRole("button", { name: "Read it again" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Read it again" })).toBeTruthy());
    await waitFor(() => expect(screen.queryByText("Read just now")).toBeNull());
  });

  it("ages: Read just now, then Read 1 minute ago", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    openPage(() => memberStatus());
    expect(await screen.findByText("Read just now")).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(61_000);
    });
    expect(await screen.findByText("Read 1 minute ago")).toBeTruthy();
    expect(screen.queryByText("Read just now")).toBeNull();
  });

  it("forgets the read when the page turns to another team", async () => {
    let repo = "boss/team";
    let holdLocal = false;
    useLicense.setState({ info: LICENSE, loaded: true } as never);
    setTeamAllowed(true);
    const { user } = renderUi(<TeamPage scope="team" />, {
      fixtures: {
        team_status: () =>
          holdLocal ? new Promise<TeamStatus>(() => {}) : memberStatus({ teamRepo: repo }),
        team_refresh: () => memberStatus({ teamRepo: repo }),
        team_work_mode: { mode: "team", chosen: true },
        team_member_states: { members: [], problems: [] },
      },
    });
    expect(await screen.findByText("Read just now")).toBeTruthy();
    // The next read names another team; that team's own reads haven't
    // landed yet.
    repo = "boss/other";
    holdLocal = true;
    await user.click(screen.getByRole("button", { name: "Read it again" }));
    await waitFor(() => expect(screen.getByText("boss/other")).toBeTruthy());
    await waitFor(() => expect(screen.queryByText("Read just now")).toBeNull());
  });
});
