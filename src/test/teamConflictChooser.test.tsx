// QoL block 13.3 (G8): the team library conflict resolver on the real
// TeamPage, the backend through the stub.
//
//  - a collision shows Keep mine / Keep theirs / Keep both per file, and
//    Put them together sends exactly those choices — once every file has one;
//  - the settled block offers Publish (the plain reapply) and Undo (local);
//  - uncommitted edits in the clone offer Move them aside.
import { latestToast } from "../store/toastStore";
import { describe, expect, it } from "vitest";
import { within } from "@testing-library/react";
import { TeamPage } from "../components/settings/TeamPage";
import type { LicenseInfo, ReapplyReport, TeamStatus } from "../ipc";
import { useLicense } from "../store/licenseStore";
import { renderUi, screen, waitFor } from "./render";
import { setTeamAllowed } from "./planGates";

const LICENSE = { status: "valid", team: "MB Adv", teamRepo: "mb/team" } as unknown as LicenseInfo;
const CLONE = "/app-support/team/mb__team";
const A = "library/claude/acme/skills/lint/SKILL.md";
const B = "library/knowledge/notes.md";

function teamStatus(over: Partial<TeamStatus> = {}): TeamStatus {
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
    libraryDivergence: { ahead: 1, behind: 1, cloneDir: CLONE },
    libraryInterruption: null,
    error: null,
    ...over,
  } as TeamStatus;
}

function report(over: Partial<ReapplyReport>): ReapplyReport {
  return {
    result: "collision",
    reapplied: 1,
    broughtIn: 1,
    paths: [A, B],
    backupRef: "refs/ply/backup/20261022T100000Z-abcdef123456",
    cloneDir: CLONE,
    message: "You and a teammate both changed SKILL.md and notes.md…",
    detail: null,
    ...over,
  };
}

const WAITING = { paths: [A, B], backupRef: "refs/ply/backup/x", asideDir: "/app-support/team-set-aside/mb__team 2026-10-22 101500", cloneDir: CLONE };

function open(fixtures: Record<string, unknown>) {
  useLicense.setState({ info: LICENSE, loaded: true } as never);
  setTeamAllowed(true);
  return renderUi(<TeamPage scope="this-mac" />, {
    fixtures: { team_work_mode: { mode: "team", chosen: true }, team_library_reveal: () => undefined, ...fixtures },
    withToasts: true,
  });
}

async function pressReapply(user: { click: (el: Element) => Promise<void> }) {
  const title = await screen.findByText("Your team library changes aren't on GitHub.");
  await user.click(within(title.closest(".ux-error") as HTMLElement).getByRole("button", { name: "Reapply mine on top" }));
}

describe("QoL 13.3: the team library conflict resolver", () => {
  it("asks per file and sends exactly the choices, settled on this Mac", async () => {
    let settled = false;
    const { user, tauri } = open({
      team_status: () => teamStatus(settled ? { libraryDivergence: null, libraryResolved: WAITING } : {}),
      team_refresh: () => teamStatus(settled ? { libraryDivergence: null, libraryResolved: WAITING } : {}),
      team_library_reapply: (args: { choices?: Record<string, string> } | undefined) => {
        if (!args?.choices) return report({});
        settled = true;
        return report({ result: "resolved", message: "Plyloft put your team library changes on top…", asideDir: "/app-support/team-set-aside/mb__team 2026-10-22 101500" });
      },
    });
    await pressReapply(user);
    const chooser = await screen.findByTestId("team-conflict-chooser");
    const put = within(chooser).getByRole("button", { name: "Put them together" });
    expect((put as HTMLButtonElement).disabled).toBe(true);
    await user.click(within(within(chooser).getByRole("group", { name: "Which version of SKILL.md to keep" })).getByRole("button", { name: "Keep mine" }));
    expect((put as HTMLButtonElement).disabled).toBe(true);
    await user.click(within(within(chooser).getByRole("group", { name: "Which version of notes.md to keep" })).getByRole("button", { name: "Keep both" }));
    expect((put as HTMLButtonElement).disabled).toBe(false);
    await user.click(put);
    await waitFor(() => expect(tauri.callsOf("team_library_reapply")).toHaveLength(2));
    expect(tauri.callsOf("team_library_reapply")[1].args).toEqual({ choices: { [A]: "mine", [B]: "both" } });
    const block = (await screen.findByText("Your choices are put together, on this Mac only.")).closest(".ux-error") as HTMLElement;
    expect(within(block).getByText(/Nothing is published yet/)).toBeTruthy();
    expect(within(block).getByRole("button", { name: "Publish" })).toBeTruthy();
    expect(within(block).getByRole("button", { name: "Undo" })).toBeTruthy();
    expect(screen.queryByTestId("team-conflict-chooser")).toBeNull();
  });

  it("a later round keeps the choices already made (Reviewer)", async () => {
    let round = 0;
    const { user, tauri } = open({
      team_status: () => teamStatus(),
      team_refresh: () => teamStatus(),
      team_library_reapply: (args: { choices?: Record<string, string> } | undefined) => {
        round += 1;
        if (!args?.choices) return report({ paths: [A] });
        return report({ paths: [A, B] });
      },
    });
    await pressReapply(user);
    let chooser = await screen.findByTestId("team-conflict-chooser");
    await user.click(within(within(chooser).getByRole("group", { name: "Which version of SKILL.md to keep" })).getByRole("button", { name: "Keep mine" }));
    await user.click(within(chooser).getByRole("button", { name: "Put them together" }));
    await waitFor(() => expect(round).toBe(2));
    chooser = await screen.findByTestId("team-conflict-chooser");
    await waitFor(() => expect(within(chooser).queryByRole("group", { name: "Which version of notes.md to keep" })).toBeTruthy());
    const mine = within(within(chooser).getByRole("group", { name: "Which version of SKILL.md to keep" })).getByRole("button", { name: "Keep mine" });
    expect(mine.getAttribute("aria-pressed")).toBe("true");
    await user.click(within(within(chooser).getByRole("group", { name: "Which version of notes.md to keep" })).getByRole("button", { name: "Keep theirs" }));
    await user.click(within(chooser).getByRole("button", { name: "Put them together" }));
    await waitFor(() => expect(tauri.callsOf("team_library_reapply")).toHaveLength(3));
    expect(tauri.callsOf("team_library_reapply")[2].args).toEqual({ choices: { [A]: "mine", [B]: "theirs" } });
  });

  it("Undo goes back locally, with no reapply and no publish", async () => {
    const waiting = { paths: [A], backupRef: "refs/ply/backup/x", asideDir: null, cloneDir: CLONE };
    let state: "waiting" | "undone" | "published" = "waiting";
    const { user, tauri } = open({
      team_status: () => teamStatus({ libraryDivergence: null, libraryResolved: state === "waiting" ? waiting : null }),
      team_refresh: () => teamStatus({ libraryDivergence: null, libraryResolved: state === "waiting" ? waiting : null }),
      team_library_undo_resolve: () => {
        state = "undone";
        return "Undone: the team library on this Mac is back as it was before your choices. Nothing was published.";
      },
      team_library_reapply: () => {
        state = "published";
        return report({ result: "published", paths: [], message: "Published your 1 change to the team library." });
      },
    });
    const block = (await screen.findByText("Your choices are put together, on this Mac only.")).closest(".ux-error") as HTMLElement;
    await user.click(within(block).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(tauri.callsOf("team_library_undo_resolve")).toHaveLength(1));
    expect(tauri.callsOf("team_library_reapply")).toHaveLength(0);
    await waitFor(() => expect(screen.queryByText("Your choices are put together, on this Mac only.")).toBeNull());
  });

  it("uncommitted edits in the clone offer Move them aside", async () => {
    const { user, tauri } = open({
      team_status: () => teamStatus(),
      team_refresh: () => teamStatus(),
      team_library_reapply: () => report({ result: "dirty", paths: [B], message: "notes.md is changed…" }),
      team_library_move_aside: () => ({ dir: "/app-support/team-set-aside/mb__team 2026-10-22 101500", paths: [B] }),
    });
    await pressReapply(user);
    const block = (await screen.findByText("The team clone has changes Plyloft didn't make.")).closest(".ux-error") as HTMLElement;
    await user.click(within(block).getByRole("button", { name: "Move them aside" }));
    await waitFor(() => expect(tauri.callsOf("team_library_move_aside")).toHaveLength(1));
    // QoL 1.168 block 8 (A2): said at once — on screen, or waiting behind
    // the refusal's warning until that one is closed.
    await waitFor(() => expect(latestToast()?.title).toBe("1 file moved aside"));
  });
});
