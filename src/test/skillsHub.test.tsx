import { describe, expect, it } from "vitest";
import type { LibraryPullView } from "../ipc";
import {
  accessLostNotice,
  leftTeamNotice,
  libraryPullLine,
  offlineTeamLine,
  pulledToastText,
  teamPhrase,
  teamRowsKey,
} from "../lib/skillsHub";

const NOW = 1_760_000_000_000;
const MIN = 60_000;

function view(over: Partial<LibraryPullView> = {}): LibraryPullView {
  return {
    library: "team:acme/team",
    repo: "acme/team",
    teamName: "Acme",
    hasClone: true,
    lastPullAt: NOW - 4 * MIN,
    lastPullCommit: "abc",
    lastAttemptAt: NOW - 4 * MIN,
    lastError: null,
    heldBack: null,
    switchedOff: false,
    accessLost: null,
    keptLastCopy: false,
    leftAt: null,
    cloneKept: null,
    login: "matteo",
    ...over,
  };
}

describe("libraryPullLine (R1, R16)", () => {
  it("says when the library was last pulled", () => {
    expect(libraryPullLine(view(), NOW)).toEqual({ text: "Updated 4 minutes ago", state: "done" });
    expect(libraryPullLine(view({ lastPullAt: NOW - 10_000 }), NOW)?.text).toBe("Updated just now");
  });

  it("keeps the last copy and says why it is not current", () => {
    expect(libraryPullLine(view({ lastPullAt: NOW - 3 * 60 * MIN, lastError: "offline" }), NOW)).toEqual({
      text: "Last updated 3 hours ago · offline",
      state: "empty",
    });
    expect(libraryPullLine(view({ lastError: "noAccess" }), NOW)?.text).toBe(
      "Last updated 4 minutes ago · GitHub refused the repository",
    );
    expect(libraryPullLine(view({ lastError: "failed" }), NOW)?.text).toBe(
      "Last updated 4 minutes ago · couldn't update",
    );
    // (Challenger) GitHub answered, but the clone holds an unpublished change.
    expect(libraryPullLine(view({ lastError: "held" }), NOW)?.text).toBe(
      "Last updated 4 minutes ago · waiting on a change on this Mac (see Settings › Team › Members and library)",
    );
  });

  it("names the plan when the gate holds the background pull back", () => {
    expect(
      libraryPullLine(view({ lastPullAt: NOW - 9 * 24 * 60 * MIN, heldBack: "plan", lastError: "offline" }), NOW)
        ?.text,
    ).toBe("Last updated 9 days ago · Team plan needed to keep it current");
  });

  it("says when nothing was downloaded yet", () => {
    expect(libraryPullLine(view({ hasClone: false, lastPullAt: null, lastError: "offline" }), NOW)?.text).toBe(
      "Not downloaded yet · couldn't reach GitHub",
    );
    expect(libraryPullLine(view({ hasClone: false, lastPullAt: null }), NOW)?.text).toBe("Not downloaded yet");
    // (Challenger) "couldn't reach GitHub" only when GitHub couldn't be asked.
    expect(libraryPullLine(view({ hasClone: false, lastPullAt: null, lastError: "noAccess" }), NOW)?.text).toBe(
      "Not downloaded yet · GitHub refused the repository",
    );
    expect(libraryPullLine(view({ hasClone: false, lastPullAt: null, lastError: "failed" }), NOW)?.text).toBe(
      "Not downloaded yet · couldn't download it",
    );
    // A clone from before H2 with no record yet: nothing to say.
    expect(libraryPullLine(view({ lastPullAt: null }), NOW)).toBeNull();
  });

  it("gives way to the switch and to leaving", () => {
    expect(libraryPullLine(view({ switchedOff: true }), NOW)?.text).toBe(
      "Switched off on this Mac · sessions get no team skills",
    );
    expect(libraryPullLine(view({ leftAt: NOW }), NOW)).toBeNull();
    expect(libraryPullLine(null, NOW)).toBeNull();
  });
});

describe("accessLostNotice (R16)", () => {
  it("names neither deletion nor revocation, and says what sessions still get", () => {
    expect(accessLostNotice(view({ accessLost: NOW, lastPullAt: NOW - 3 * 24 * 60 * MIN }), NOW)).toBe(
      "acme/team isn't reachable with matteo's GitHub account any more. Your sessions still get the copy from 3 days ago.",
    );
  });

  it("is gone once answered, switched off, or not asked", () => {
    expect(accessLostNotice(view(), NOW)).toBeNull();
    expect(accessLostNotice(view({ accessLost: NOW, keptLastCopy: true }), NOW)).toBeNull();
    expect(accessLostNotice(view({ accessLost: NOW, switchedOff: true }), NOW)).toBeNull();
  });
});

describe("leftTeamNotice (R17)", () => {
  it("says the team is gone from this Mac and repository copies stay", () => {
    expect(leftTeamNotice(view({ leftAt: NOW }))).toBe(
      "You're no longer in Acme's team. Its library left this Mac. Skills copied into repositories stay as they are.",
    );
    expect(leftTeamNotice(view({ leftAt: NOW, teamName: null, cloneKept: "this drive has no Recycle Bin" }))).toBe(
      "You're no longer in acme/team. Its copy stays on this Mac (this drive has no Recycle Bin). Skills copied into repositories stay as they are.",
    );
    expect(leftTeamNotice(view())).toBeNull();
  });

  it("(Windows walk) never says \"… team's team\"", () => {
    expect(leftTeamNotice(view({ leftAt: NOW, teamName: "Plyloft test team" }))).toBe(
      "You're no longer in Plyloft test team. Its library left this Mac. Skills copied into repositories stay as they are.",
    );
    expect(teamPhrase("Acme")).toBe("Acme's team");
    expect(teamPhrase(" Acme TEAM ")).toBe("Acme TEAM");
    expect(teamPhrase("test-owner/plyloft-test-team")).toBe("test-owner/plyloft-test-team");
    expect(teamPhrase("Steam")).toBe("Steam");
  });
});

describe("offlineTeamLine (Windows walk: Settings › Team offline)", () => {
  const raw =
    "Could not pull the team repo: git fetch failed: fatal: unable to access 'https://github.com/acme/team.git/': Could not resolve host: github.com " +
    "Could not read your GitHub login: error connecting to api.github.com";

  it("says it plainly and names the copy sessions use", () => {
    expect(offlineTeamLine(raw, view({ lastError: "offline", lastPullAt: NOW - 3 * 60 * MIN }), NOW)).toBe(
      "Couldn't reach GitHub. New sessions use the copy from 3 hours ago.",
    );
    // The record not read yet: the words alone are enough.
    expect(offlineTeamLine(raw, null, NOW)).toBe(
      "Couldn't reach GitHub, so the team library isn't on this Mac yet.",
    );
    expect(offlineTeamLine(raw, view({ lastPullAt: null }), NOW)).toBe(
      "Couldn't reach GitHub. New sessions use the copy on this Mac.",
    );
  });

  it("leaves any other error in its own words", () => {
    expect(offlineTeamLine(null, view({ lastError: "offline" }), NOW)).toBeNull();
    expect(offlineTeamLine("team.json is not readable: EOF", view({ lastError: "offline" }), NOW)).toBeNull();
    expect(
      offlineTeamLine(`${raw} Could not read the team manifest: team.json is not readable`, view(), NOW),
    ).toBeNull();
    expect(offlineTeamLine("Could not pull the team repo: Repository not found.", view(), NOW)).toBeNull();
  });
});

describe("teamRowsKey (Windows walk: the Library's team section follows)", () => {
  it("moves on leaving, rejoining, switching and a pull that brought a commit — not on a pull that brought nothing", () => {
    const base = teamRowsKey(view());
    expect(teamRowsKey(view({ lastPullAt: NOW, lastAttemptAt: NOW }))).toBe(base);
    expect(teamRowsKey(view({ leftAt: NOW }))).not.toBe(base);
    expect(teamRowsKey(view({ hasClone: false }))).not.toBe(base);
    expect(teamRowsKey(view({ switchedOff: true }))).not.toBe(base);
    expect(teamRowsKey(view({ lastPullCommit: "def" }))).not.toBe(base);
    expect(teamRowsKey(null)).toBe("");
  });
});

describe("pulledToastText (R1, R14: one toast per pull)", () => {
  const pulled = (changes: { skill: string; authors: string[] }[]) => ({
    library: "team:acme/team",
    teamName: "Acme",
    changes,
  });

  it("names who changed which skill", () => {
    expect(pulledToastText(pulled([{ skill: "review-rules", authors: ["Ana"] }]))).toBe(
      "Ana changed review-rules",
    );
  });

  it("groups several skills and several people", () => {
    expect(
      pulledToastText(
        pulled([
          { skill: "review-rules", authors: ["Ana"] },
          { skill: "deploy", authors: ["Ana"] },
          { skill: "check", authors: ["Ana"] },
        ]),
      ),
    ).toBe("Ana changed review-rules and 2 more");
    expect(
      pulledToastText(
        pulled([
          { skill: "review-rules", authors: ["Ana", "Bo"] },
          { skill: "check", authors: ["Bo"] },
        ]),
      ),
    ).toBe("Ana and Bo changed review-rules and 1 more");
    expect(pulledToastText(pulled([{ skill: "x", authors: ["Ana", "Bo", "Cy"] }]))).toBe(
      "Ana and 2 others changed x",
    );
    expect(pulledToastText(pulled([{ skill: "x", authors: [] }]))).toBe("Someone changed x");
  });

  it("says nothing when no skill changed", () => {
    expect(pulledToastText(pulled([]))).toBeNull();
  });
});
