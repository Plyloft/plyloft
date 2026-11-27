// 1.176.2 (A5F-08): in This repository's settings, an older Undo can never
// overwrite a newer value. The path: change Name twice inside the 6 s, dismiss
// the newer Undo with its ×, and press the older one that comes back.
import { describe, expect, it } from "vitest";
import { RepositoryBuildRelease, RepositoryGeneral } from "../components/RepositorySettings";
import { BoardPage } from "../components/settings/BoardPage";
import { useWorkspaces } from "../store/workspaceStore";
import { UNDO_SUPERSEDED } from "../lib/undoable";
import { renderUi, screen, waitFor } from "./render";

const WS = "ws-undo";

describe("This repository: an older Undo", () => {
  it("does not put back a value the page has moved on from", async () => {
    let name = "alpha";
    const list = () => [
      { id: WS, name, cwd: "/tmp/a", createdAt: 1, lastOpenedAt: 1, openFiles: [], activeFile: null, models: null },
    ];
    useWorkspaces.setState({ activeId: WS, workspaces: list() } as never);
    const r = renderUi(
      <RepositoryGeneral workspaceId={WS} board={<BoardPage scope="repository" workspaceId={WS} />} />,
      {
        withToasts: true,
        fixtures: {
          workspace_definition_get: null,
          project_config_get: { schemaVersion: 2, targetBranch: "main", versionFiles: [], installScript: null, verifyPipeline: null, createdAt: 0, updatedAt: 0 },
          project_review_get: { selfCheck: true, reviewChecklist: [] },
          worktree_settings_get: {},
          workspace_rename: ({ name: next }: Record<string, unknown>) => {
            name = String(next);
            return null;
          },
          workspace_list: () => ({ workspaces: list(), activeId: WS }),
          workspace_cwd_exists: true,
          workspace_adoption_status: () => ({ githubRepo: "o/a", hasDefinition: true, boardRepo: "o/a", action: { kind: "none" } }),
        },
      },
    );
    r.tauri.allowUnhandled();
    const box = (await screen.findByRole("textbox", { name: "Name" })) as HTMLInputElement;
    const type = async (to: string) => {
      await r.user.clear(box);
      await r.user.type(box, to);
      await r.user.tab();
    };
    await type("beta");
    await waitFor(() => expect(name).toBe("beta"));
    await type("gamma");
    await waitFor(() => expect(name).toBe("gamma"));
    // The newer Undo is on screen; closing it brings the older one back.
    await r.user.click(await screen.findByRole("button", { name: "Dismiss" }));
    const older = await screen.findByRole("button", { name: "Undo" });
    await r.user.click(older);
    // "alpha" must not be written over "gamma".
    expect(await screen.findByText(UNDO_SUPERSEDED)).toBeTruthy();
    expect(name).toBe("gamma");
  });

  it("still undoes the emptying of a list (the last cache path)", async () => {
    let config: Record<string, unknown> = {
      schemaVersion: 2, targetBranch: "main", versionFiles: [], installScript: null, verifyPipeline: null,
      cachePaths: ["target"], createdAt: 0, updatedAt: 0,
    };
    useWorkspaces.setState({ activeId: WS, workspaces: [{ id: WS, name: "alpha", cwd: "/tmp/a", createdAt: 1, lastOpenedAt: 1, openFiles: [], activeFile: null, models: null }] } as never);
    const r = renderUi(<RepositoryBuildRelease workspaceId={WS} cwd="/tmp/a" />, {
      withToasts: true,
      fixtures: {
        workspace_definition_get: null,
        project_config_get: () => config,
        project_config_set: ({ config: next }: Record<string, unknown>) => {
          config = next as Record<string, unknown>;
          return config;
        },
        project_review_get: { selfCheck: true, reviewChecklist: [] },
        project_config_detect: { config, hasClaudeMd: false, notes: [] },
        workspace_definition_branches: { branches: ["main"], defaultBranch: "main", error: null, hasOrigin: true },
        worktree_settings_get: {},
        project_try_command_get: { command: null, approved: true, shared: false, readOnly: false, hasConfig: true, detection: { kind: "none" } },
        workspace_adoption_status: () => ({ githubRepo: "o/a", hasDefinition: true, boardRepo: "o/a", action: { kind: "none" } }),
      },
    });
    r.tauri.allowUnhandled();
    await r.user.click(await screen.findByRole("button", { name: /Cache paths|Extra cache paths/ }));
    await r.user.click(await screen.findByRole("button", { name: "More for target" }));
    await r.user.click(await screen.findByRole("menuitem", { name: "Remove" }));
    await waitFor(() => expect(config.cachePaths).toEqual([]));
    await r.user.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(config.cachePaths).toEqual(["target"]));
    expect(screen.queryByText(UNDO_SUPERSEDED)).toBeNull();
  });
});
