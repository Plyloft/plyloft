// GH #226: a team clone ahead AND behind GitHub gets a way out — "Reapply
// mine on top". The real TeamPage; the backend through the stub. (The
// Knowledge panel's toast, the other surface, went with the panel: UX-9.5
// retired Notes, UX-10.2 its code.)
//
//  - Settings › Team draws the divergence as an error block with the action;
//    pressing it calls `team_library_reapply` once and re-reads the clone,
//    and the block goes once the clone is back in step;
//  - a collision replaces it with a block naming the file, and offers no
//    press that would only collide again;
//  - a clone in step shows no block (the control).
import { describe, expect, it } from "vitest";
import { within } from "@testing-library/react";
import { TeamPage } from "../components/settings/TeamPage";
import type { LicenseInfo, ReapplyReport, TeamStatus } from "../ipc";
import { useLicense } from "../store/licenseStore";
import { renderUi, screen, waitFor } from "./render";
import { setTeamAllowed } from "./planGates";

const LICENSE = {
  status: "valid",
  team: "MB Adv",
  teamRepo: "mb/team",
} as unknown as LicenseInfo;

const CLONE = "/app-support/team/mb__team";
const DIVERGED_2 = { ahead: 1, behind: 2, cloneDir: CLONE };

function teamStatus(
  divergence: TeamStatus["libraryDivergence"],
  interruption: TeamStatus["libraryInterruption"] = null,
): TeamStatus {
  return {
    teamRepo: "mb/team",
    teamName: "MB Adv",
    ownerLogin: "owner",
    members: [],
    isOwner: false,
    ignoredRepos: [],
    login: "me",
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
    libraryDivergence: divergence,
    libraryInterruption: interruption,
    error: null,
  };
}

function report(over: Partial<ReapplyReport>): ReapplyReport {
  return {
    result: "published",
    reapplied: 1,
    broughtIn: 2,
    paths: [],
    backupRef: "refs/ply/backup/20260923T100000Z-abcdef123456",
    cloneDir: CLONE,
    message: "Published your 1 change to the team library.",
    detail: null,
    ...over,
  };
}

/** The clone is diverged until a reapply publishes. */
function teamFixtures(answer: ReapplyReport) {
  let diverged = true;
  return {
    team_status: () => teamStatus(diverged ? DIVERGED_2 : null),
    team_refresh: () => teamStatus(diverged ? DIVERGED_2 : null),
    // OB-9: a refresh asks the work mode again (a clone is a team signal).
    team_work_mode: { mode: "team", chosen: true },
    team_library_reveal: () => undefined,
    team_library_reapply: () => {
      if (answer.result === "published") diverged = false;
      return answer;
    },
  };
}

function openTeamPage(answer: ReapplyReport) {
  useLicense.setState({ info: LICENSE, loaded: true } as never);
  setTeamAllowed(true);
  return renderUi(<TeamPage scope="this-mac" />, {
    fixtures: teamFixtures(answer),
    withToasts: true,
  });
}

describe("Settings › Team: a diverged team clone (GH #226)", () => {
  it("offers Reapply mine on top, runs it once, and the block goes when in step", async () => {
    const { user, tauri } = openTeamPage(report({}));
    const title = await screen.findByText("Your team library changes aren't on GitHub.");
    const block = title.closest(".ux-error") as HTMLElement;
    expect(within(block).getByText(/This Mac has 1 change to the team library/)).toBeTruthy();
    expect(within(block).getByText(/published 2 changes meanwhile/)).toBeTruthy();
    // The clone's path is in Details, not in the sentences.
    expect(within(block).getByText(/What happened/).parentElement?.textContent).not.toContain(CLONE);
    expect(block.textContent).toContain(`Team clone: ${CLONE}`);

    await user.click(within(block).getByRole("button", { name: "Reapply mine on top" }));
    await screen.findByText("Your team library changes are published.");
    expect(tauri.callsOf("team_library_reapply")).toHaveLength(1);
    await waitFor(() =>
      expect(screen.queryByText("Your team library changes aren't on GitHub.")).toBeNull(),
    );
    expect(screen.queryByRole("button", { name: "Reapply mine on top" })).toBeNull();
  });

  it("a collision names the file, says nothing was lost, and offers Finder, not the press", async () => {
    const collided = report({
      result: "collision",
      paths: ["library/knowledge/same.md"],
      detail: "CONFLICT (content): Merge conflict in library/knowledge/same.md",
      message: "You and a teammate both changed same.md…",
    });
    const { user, tauri } = openTeamPage(collided);
    const title = await screen.findByText("Your team library changes aren't on GitHub.");
    await user.click(
      within(title.closest(".ux-error") as HTMLElement).getByRole("button", {
        name: "Reapply mine on top",
      }),
    );
    const collision = await screen.findByText("You and a teammate changed the same file.");
    const block = collision.closest(".ux-error") as HTMLElement;
    expect(within(block).getByText(/Both of you changed same\.md/)).toBeTruthy();
    expect(within(block).getByText(/nothing was published or lost/)).toBeTruthy();
    expect(within(block).queryByRole("button", { name: "Reapply mine on top" })).toBeNull();
    await user.click(within(block).getByRole("button", { name: "Show in Finder" }));
    expect(tauri.callsOf("team_library_reveal")).toHaveLength(1);
    // Details holds the backup and git's words.
    expect(block.textContent).toContain("refs/ply/backup/20260923T100000Z-abcdef123456");
    expect(screen.getByText("Reapply stopped: the same file changed on both sides.")).toBeTruthy();
    expect(tauri.callsOf("team_library_reapply")).toHaveLength(1);
  });

  it("Plyloft's own interrupted reapply offers the press; one Plyloft didn't start offers only Finder", async () => {
    useLicense.setState({ info: LICENSE, loaded: true } as never);
    setTeamAllowed(true);
    const own = renderUi(<TeamPage scope="this-mac" />, {
      fixtures: {
        team_status: () => teamStatus(null, { own: true, cloneDir: CLONE }),
        team_refresh: () => teamStatus(null, { own: true, cloneDir: CLONE }),
        // OB-9: a refresh asks the work mode again (a clone is a team signal).
        team_work_mode: { mode: "team", chosen: true },
      },
    });
    const title = await screen.findByText("Plyloft's last reapply didn't finish.");
    const block = title.closest(".ux-error") as HTMLElement;
    expect(within(block).getByRole("button", { name: "Reapply mine on top" })).toBeTruthy();
    own.unmount();

    renderUi(<TeamPage scope="this-mac" />, {
      fixtures: {
        team_status: () => teamStatus(null, { own: false, cloneDir: CLONE }),
        team_refresh: () => teamStatus(null, { own: false, cloneDir: CLONE }),
        // OB-9: a refresh asks the work mode again (a clone is a team signal).
        team_work_mode: { mode: "team", chosen: true },
      },
    });
    const foreign = await screen.findByText("The team clone is in the middle of a git merge.");
    const other = foreign.closest(".ux-error") as HTMLElement;
    expect(within(other).queryByRole("button", { name: "Reapply mine on top" })).toBeNull();
    expect(within(other).getByRole("button", { name: "Show in Finder" })).toBeTruthy();
    expect(other.textContent).toContain(`Team clone: ${CLONE}`);
  });

  it("a clone in step shows no block and no action", async () => {
    useLicense.setState({ info: LICENSE, loaded: true } as never);
    setTeamAllowed(true);
    renderUi(<TeamPage scope="this-mac" />, {
      fixtures: {
        team_status: () => teamStatus(null),
        team_refresh: () => teamStatus(null),
        // OB-9: a refresh asks the work mode again (a clone is a team signal).
        team_work_mode: { mode: "team", chosen: true },
      },
    });
    await screen.findByText(/Member of/);
    expect(screen.queryByText("Your team library changes aren't on GitHub.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Reapply mine on top" })).toBeNull();
  });
});
