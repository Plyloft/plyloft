// OB-8 (owner decision "ask first"): where the backend offers the move instead
// of running it (`offerBoard`), the banner asks once — "Move to GitHub Issues"
// or "Keep it on this Mac" — and nothing is switched or migrated until the
// press. After "Move", the status is the switch to the repository's GitHub
// Issues board, which runs as it always has. R14 (1.169.1): a board the
// repository's definition says is Local puts up no banner; only Settings ›
// Board moves it, after saying it changes the board for everyone.
import { describe, expect, it } from "vitest";
import { AdoptionBanner } from "../components/AdoptionBanner";
import { KeptOwnSetupRow } from "../components/RepositorySettings";
import { BoardPage } from "../components/settings/BoardPage";
import { useWorkspaces, type Workspace } from "../store/workspaceStore";
import type { AdoptionStatus } from "../lib/adoption";
import type { LicenseInfo } from "../ipc";
import { useLicense } from "../store/licenseStore";
import { act, renderUi, screen, tauri, waitFor, within } from "./render";
import { setTeamAllowed } from "./planGates";
import { setPlatformForTests } from "../lib/platform";

const LICENCE: LicenseInfo = {
  status: "none",
  team: null,
  seats: null,
  issuedAt: null,
  expiresAt: null,
  teamRepo: null,
};

const status = (action: AdoptionStatus["action"]): AdoptionStatus => ({
  githubRepo: "o/lyra",
  hasDefinition: true,
  boardRepo: "o/lyra",
  action,
});

/** The backend as the banner sees it: the offer until "Move" is recorded,
 *  then the automatic switch; nothing once "Keep it" is. */
function backend(first: AdoptionStatus["action"]) {
  let choice: boolean | null = null;
  let switched = false;
  return {
    workspace_adoption_status: () =>
      switched
        ? status({ kind: "none" })
        : choice === null
          ? status(first)
          : choice
            ? status({ kind: "switchBoard", localCards: 2 })
            : status({ kind: "boardKeptLocal", localCards: 2, cardsOnly: false }),
    workspace_adoption_board_choice: ({ moved }: Record<string, unknown>) => {
      choice = moved as boolean;
      return null;
    },
    workspace_set_kanban_sync_mode: () => {
      switched = true;
      return 2;
    },
    kanban_github_push_local: () => ({ pushed: 2, failed: 0 }),
    kanban_github_reconcile: () => ({}),
    kanban_list: () => [],
    workspace_list: () => ({ workspaces: [], activeId: null }),
  };
}

// The banner keeps its once-per-session guards per workspace, module-wide, so
// every test uses a workspace of its own.
let n = 0;
function render(first: AdoptionStatus["action"]) {
  tauri().allowUnhandled();
  useLicense.setState({ info: LICENCE, loaded: true } as never);
  setTeamAllowed(true);
  n += 1;
  return renderUi(<AdoptionBanner workspaceId={`ws-${n}`} />, { fixtures: backend(first) });
}

describe("The board offer while teams are free (OB-8)", () => {
  it("offers and changes nothing until the press", async () => {
    render({ kind: "offerBoard", localCards: 2, cardsOnly: false });
    expect(
      await screen.findByRole("region", { name: "Move this board to GitHub Issues?" }),
    ).toBeTruthy();
    expect(screen.getByText(/2 local cards become issues in o\/lyra/)).toBeTruthy();
    await act(async () => {});
    expect(tauri().callsOf("workspace_set_kanban_sync_mode")).toHaveLength(0);
    expect(tauri().callsOf("kanban_github_push_local")).toHaveLength(0);
  });

  it("moves the board and its cards on the press", async () => {
    const { user } = render({ kind: "offerBoard", localCards: 2, cardsOnly: false });
    await user.click(await screen.findByRole("button", { name: "Move to GitHub Issues" }));
    expect(tauri().callsOf("workspace_adoption_board_choice")[0].args.moved).toBe(true);
    await waitFor(() =>
      expect(tauri().callsOf("workspace_set_kanban_sync_mode")).toHaveLength(1),
    );
    expect(tauri().callsOf("workspace_set_kanban_sync_mode")[0].args).toMatchObject({
      mode: "githubIssues",
      repo: "o/lyra",
    });
    await waitFor(() => expect(tauri().callsOf("kanban_github_push_local")).toHaveLength(1));
  });

  // R14: a board the repository's definition says is Local — on any plan —
  // puts up no banner and is never switched or published on its own.
  it("puts up nothing for a board the repository says is Local", async () => {
    tauri().allowUnhandled();
    useLicense.setState({ info: LICENCE, loaded: true } as never);
    setTeamAllowed(true);
    n += 1;
    renderUi(<AdoptionBanner workspaceId={`ws-${n}`} />, {
      fixtures: {
        ...backend({ kind: "none" }),
        workspace_adoption_status: () => ({ ...status({ kind: "none" }), repoBoard: "local" }),
      },
    });
    await waitFor(() => expect(tauri().callsOf("workspace_adoption_status").length).toBeGreaterThan(0));
    await act(async () => {});
    expect(screen.queryByRole("region")).toBeNull();
    expect(screen.queryByRole("button", { name: "Move to GitHub Issues" })).toBeNull();
    expect(tauri().callsOf("workspace_set_kanban_sync_mode")).toHaveLength(0);
    expect(tauri().callsOf("workspace_adoption_board_choice")).toHaveLength(0);
    expect(tauri().callsOf("workspace_definition_publish")).toHaveLength(0);
  });

  it("keeps it on this Mac and does not offer again", async () => {
    const { user } = render({ kind: "offerBoard", localCards: 2, cardsOnly: false });
    await user.click(await screen.findByRole("button", { name: "Keep it on this Mac" }));
    expect(tauri().callsOf("workspace_adoption_board_choice")[0].args.moved).toBe(false);
    await waitFor(() =>
      expect(screen.queryByText("Move this board to GitHub Issues?")).toBeNull(),
    );
    expect(tauri().callsOf("workspace_set_kanban_sync_mode")).toHaveLength(0);
    expect(tauri().callsOf("kanban_github_push_local")).toHaveLength(0);
  });

  it("with a key (or a paid tier) the switch runs on its own, as before", async () => {
    render({ kind: "switchBoard", localCards: 2 });
    await waitFor(() =>
      expect(tauri().callsOf("workspace_set_kanban_sync_mode")).toHaveLength(1),
    );
    expect(screen.queryByText("Move this board to GitHub Issues?")).toBeNull();
    expect(tauri().callsOf("workspace_adoption_board_choice")).toHaveLength(0);
  });
});

describe("Only local cards waiting, and a board kept on this Mac (OB-8 review 2)", () => {
  it("asks about the cards in their own words", async () => {
    render({ kind: "offerBoard", localCards: 2, cardsOnly: true });
    expect(
      await screen.findByRole("region", { name: "Move this Mac's local cards to GitHub Issues?" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Move them to GitHub Issues" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Keep them on this Mac" })).toBeTruthy();
  });

  it("names the machine as Windows does (n15)", async () => {
    setPlatformForTests("windows");
    render({ kind: "offerBoard", localCards: 2, cardsOnly: true });
    expect(
      await screen.findByRole("region", { name: "Move this PC's local cards to GitHub Issues?" }),
    ).toBeTruthy();
    expect(screen.getByText(/This PC's 2 local cards become issues in o\/lyra/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Keep them on this PC" })).toBeTruthy();
  });

  it("Board says it was kept here, and one press moves it after all", async () => {
    tauri().allowUnhandled();
    useLicense.setState({ info: LICENCE, loaded: true } as never);
    setTeamAllowed(true);
    useWorkspaces.setState({
      workspaces: [
        { id: "ws-kept", name: "lyra", cwd: "/repo/lyra", kanbanSyncMode: "local" } as Workspace,
      ],
      activeId: "ws-kept",
    } as never);
    const kept = status({ kind: "boardKeptLocal", localCards: 2, cardsOnly: false });
    const { user } = renderUi(
      <BoardPage scope="repository" workspaceId="ws-kept" adoption={kept} />,
      { fixtures: backend({ kind: "boardKeptLocal", localCards: 2, cardsOnly: false }) },
    );
    expect(screen.getByText("Kept on this Mac")).toBeTruthy();
    expect(screen.getByText(/this Mac keeps its board here/)).toBeTruthy();
    // The generic "Back the board with GitHub Issues" is not drawn beside it.
    expect(screen.queryByText("Back the board with GitHub Issues")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Move to GitHub Issues" }));
    await waitFor(() => expect(tauri().callsOf("kanban_github_push_local")).toHaveLength(1));
    expect(tauri().callsOf("workspace_adoption_board_choice")[0].args.moved).toBe(true);
    expect(tauri().callsOf("workspace_set_kanban_sync_mode")[0].args).toMatchObject({
      mode: "githubIssues",
      repo: "o/lyra",
    });
  });

  // R14: the repository's definition says Local. The row names the
  // repository's board, and its Move says before acting that the board
  // changes for everyone; then one switch runs (one config change).
  function renderLocalRepoBoard(action: AdoptionStatus["action"]) {
    tauri().allowUnhandled();
    useLicense.setState({ info: LICENCE, loaded: true } as never);
    setTeamAllowed(true);
    useWorkspaces.setState({
      workspaces: [
        { id: "ws-repo-local", name: "lyra", cwd: "/repo/lyra", kanbanSyncMode: "local" } as Workspace,
      ],
      activeId: "ws-repo-local",
    } as never);
    const adoption = { ...status(action), repoBoard: "local" as const };
    return renderUi(
      <BoardPage
        scope="repository"
        workspaceId="ws-repo-local"
        setByRepository={action.kind === "none"}
        adoption={adoption}
      />,
      // Two-account walk: the press reads again first, and finds the same answer.
      {
        fixtures: {
          ...backend(action),
          workspace_adoption_status: () => adoption,
          workspace_list: () => ({ workspaces: useWorkspaces.getState().workspaces, activeId: "ws-repo-local" }),
          workspace_cwd_exists: true,
        },
      },
    );
  }

  for (const action of [
    { kind: "none" },
    { kind: "boardKeptLocal", localCards: 2, cardsOnly: false },
  ] as const) {
    it(`a repository whose board is Local (${action.kind}): says so, and asks before the move`, async () => {
      const { user } = renderLocalRepoBoard(action);
      expect(screen.getByText(/This repository's board is Local\./)).toBeTruthy();
      expect(screen.queryByText(/The team's board is GitHub Issues/)).toBeNull();
      expect(screen.queryByText("Kept on this Mac")).toBeNull();
      // Cancel: nothing runs.
      await user.click(screen.getByRole("button", { name: "Move to GitHub Issues" }));
      let sheet = await screen.findByRole("dialog", {
        name: "Move this repository's board to GitHub Issues?",
      });
      expect(
        within(sheet).getByText(
          "Moving the board to GitHub Issues changes it for everyone who opens this repository.",
        ),
      ).toBeTruthy();
      await user.click(within(sheet).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(tauri().callsOf("workspace_adoption_board_choice")).toHaveLength(0);
      expect(tauri().callsOf("workspace_set_kanban_sync_mode")).toHaveLength(0);
      // Confirmed: the board switches once, nothing else is published.
      await user.click(screen.getByRole("button", { name: "Move to GitHub Issues" }));
      sheet = await screen.findByRole("dialog", {
        name: "Move this repository's board to GitHub Issues?",
      });
      await user.click(within(sheet).getByRole("button", { name: "Move to GitHub Issues" }));
      await waitFor(() => expect(tauri().callsOf("kanban_github_push_local")).toHaveLength(1));
      expect(tauri().callsOf("workspace_set_kanban_sync_mode")).toHaveLength(1);
      expect(tauri().callsOf("workspace_set_kanban_sync_mode")[0].args).toMatchObject({
        mode: "githubIssues",
        repo: "o/lyra",
      });
      expect(tauri().callsOf("workspace_definition_publish")).toHaveLength(0);
    });
  }

  it("the team's board with cards kept here: the row is there, the board is not switched", async () => {
    tauri().allowUnhandled();
    useLicense.setState({ info: LICENCE, loaded: true } as never);
    setTeamAllowed(true);
    useWorkspaces.setState({
      workspaces: [
        { id: "ws-cards", name: "lyra", cwd: "/repo/lyra", kanbanSyncMode: "githubIssues" } as Workspace,
      ],
      activeId: "ws-cards",
    } as never);
    const kept = status({ kind: "boardKeptLocal", localCards: 2, cardsOnly: true });
    const { user } = renderUi(
      <BoardPage scope="repository" workspaceId="ws-cards" setByRepository adoption={kept} />,
      { fixtures: backend({ kind: "boardKeptLocal", localCards: 2, cardsOnly: true }) },
    );
    await user.click(screen.getByRole("button", { name: "Move them to GitHub Issues" }));
    await waitFor(() => expect(tauri().callsOf("kanban_github_push_local")).toHaveLength(1));
    expect(tauri().callsOf("workspace_set_kanban_sync_mode")).toHaveLength(0);
  });
});

// Team walk 2026-10-02 (T1): a member whose clone still has a local board,
// in a repository whose shared definition already says GitHub Issues, is
// joining that board, not setting one up.
describe("The board offer when the repository already uses GitHub Issues", () => {
  it("says the board is there and offers Use it here", async () => {
    tauri().allowUnhandled();
    useLicense.setState({ info: LICENCE, loaded: true } as never);
    setTeamAllowed(true);
    n += 1;
    const { user } = renderUi(<AdoptionBanner workspaceId={`ws-${n}`} />, {
      fixtures: {
        ...backend({ kind: "offerBoard", localCards: 0, cardsOnly: false }),
        workspace_definition_get: () => ({
          cache: { definition: { schemaVersion: 1, name: "x", board: "githubIssues" } },
        }),
      },
    });
    expect(
      await screen.findByRole("region", { name: "The team's board is on GitHub Issues" }),
    ).toBeTruthy();
    expect(screen.queryByText("Move this board to GitHub Issues?")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Use it here" }));
    await waitFor(() =>
      expect(tauri().callsOf("workspace_adoption_board_choice")[0]?.args).toMatchObject({
        moved: true,
      }),
    );
  });
});

describe("A shared setup found on another branch (X2, 1.171.0)", () => {
  function renderElsewhere() {
    tauri().allowUnhandled();
    useLicense.setState({ info: LICENCE, loaded: true } as never);
    setTeamAllowed(true);
    n += 1;
    let answered: boolean | null = null;
    const fixtures = {
      workspace_adoption_status: () =>
        answered === null
          ? status({ kind: "setupElsewhere", here: "walk-ux-1171", branch: "walk-1170-rel", name: "d1170-rel" })
          : status({ kind: "none" }),
      workspace_adoption_setup_elsewhere: ({ useIt }: Record<string, unknown>) => {
        answered = useIt as boolean;
        return null;
      },
      workspace_list: () => ({ workspaces: [], activeId: null }),
    };
    return renderUi(<AdoptionBanner workspaceId={`ws-${n}`} />, { fixtures });
  }

  it("asks once, and keeping the folder's own setup is remembered", async () => {
    const { user } = renderElsewhere();
    const region = await screen.findByRole("region", {
      name: "This project has a shared setup on GitHub",
    });
    expect(within(region).getByText(/^It was made for walk-1170-rel\. This folder uses its own setup/)).toBeTruthy();
    // D6 Challenger: both bordered — the Board's one filled button is New card.
    expect(within(region).getByRole("button", { name: "Keep this folder's setup" }).className).not.toContain("primary");
    expect(within(region).getByRole("button", { name: "Use the shared setup" }).className).not.toContain("primary");
    expect(region.querySelector(".primary")).toBeNull();
    // B1 (walk 2026-10-27): named by its branch, not the project name it carries.
    expect(within(region).queryByText(/d1170-rel/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Keep this folder's setup" }));
    expect(screen.queryByText("Setting up…")).toBeNull();
    expect(tauri().callsOf("workspace_adoption_setup_elsewhere")[0].args.useIt).toBe(false);
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: /shared setup on GitHub/ })).toBeNull(),
    );
  });

  it("uses the setup found on the press", async () => {
    const { user } = renderElsewhere();
    await user.click(await screen.findByRole("button", { name: "Use the shared setup" }));
    expect(tauri().callsOf("workspace_adoption_setup_elsewhere")[0].args).toMatchObject({
      useIt: true,
      branch: null,
    });
    await waitFor(() => expect(tauri().callsOf("workspace_list").length).toBeGreaterThan(0));
  });

  it("B1: with several setups, names them all and uses the one chosen", async () => {
    tauri().allowUnhandled();
    setTeamAllowed(true);
    n += 1;
    const { user } = renderUi(<AdoptionBanner workspaceId={`ws-${n}`} />, {
      fixtures: {
        workspace_adoption_status: () =>
          status({
            kind: "setupElsewhere",
            here: "main",
            branch: "walk-1170-rel",
            name: "d1170-rel",
            others: ["staging"],
          }),
        workspace_adoption_setup_elsewhere: () => null,
        workspace_list: () => ({ workspaces: [], activeId: null }),
      },
    });
    const region = await screen.findByRole("region", {
      name: "This project has shared setups on GitHub",
    });
    expect(within(region).getByText(/^They were made for walk-1170-rel and staging\. This folder uses its own setup until you choose/)).toBeTruthy();
    expect(within(region).getByRole("button", { name: "Keep this folder's setup" })).toBeTruthy();
    expect(within(region).getByRole("button", { name: "Use the one for walk-1170-rel" })).toBeTruthy();
    expect(within(region).queryByRole("button", { name: "Use the shared setup" })).toBeNull();
    await user.click(within(region).getByRole("button", { name: "Use the one for staging" }));
    expect(tauri().callsOf("workspace_adoption_setup_elsewhere")[0].args).toMatchObject({
      useIt: true,
      branch: "staging",
    });
  });
});

describe("The way back after keeping the folder's own setup (X2)", () => {
  it("Settings › General uses the shared setup on a press", async () => {
    tauri().allowUnhandled();
    n += 1;
    const { user } = renderUi(<KeptOwnSetupRow workspaceId={`ws-${n}`} />, {
      fixtures: {
        workspace_adoption_status: () => ({ ...status({ kind: "none" }), keptOwnSetup: "walk-1170-rel" }),
        workspace_adoption_setup_elsewhere: () => null,
        workspace_list: () => ({ workspaces: [], activeId: null }),
      },
    });
    await user.click(await screen.findByRole("button", { name: "Use the shared setup for walk-1170-rel" }));
    expect(tauri().callsOf("workspace_adoption_setup_elsewhere")[0].args.useIt).toBe(true);
  });

  it("B1: offers each of several setups kept with the answer", async () => {
    tauri().allowUnhandled();
    n += 1;
    const { user } = renderUi(<KeptOwnSetupRow workspaceId={`ws-${n}`} />, {
      fixtures: {
        workspace_adoption_status: () => ({
          ...status({ kind: "none" }),
          keptOwnSetup: "walk-1170-rel",
          keptOwnSetupOthers: ["staging"],
        }),
        workspace_adoption_setup_elsewhere: () => null,
        workspace_list: () => ({ workspaces: [], activeId: null }),
      },
    });
    await user.click(await screen.findByRole("button", { name: "Use the one for staging" }));
    expect(screen.getByRole("button", { name: "Use the one for walk-1170-rel" })).toBeTruthy();
    expect(tauri().callsOf("workspace_adoption_setup_elsewhere")[0].args).toMatchObject({
      useIt: true,
      branch: "staging",
    });
  });

  it("says nothing while no answer was kept", async () => {
    tauri().allowUnhandled();
    n += 1;
    renderUi(<KeptOwnSetupRow workspaceId={`ws-${n}`} />, {
      fixtures: { workspace_adoption_status: () => status({ kind: "none" }) },
    });
    await act(async () => {});
    expect(screen.queryByRole("button", { name: /Use the shared setup/ })).toBeNull();
  });
});
