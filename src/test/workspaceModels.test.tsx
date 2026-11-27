// CL-4: the open workspace's own Builder/Challenger models, drawn under the
// app rows on Claude and Codex. Each row says what will really run and where
// each part comes from; a choice is written through `workspace_set_models`
// (workspaces.json, this Mac), never through settings.json. Round 2: an
// explicit "The tool's default" per field, and quick successive edits that never
// overwrite each other.
import { describe, expect, it } from "vitest";
import { TeamModelsPage, TeamModelsSection, WorkspaceModelsSection } from "../components/settings/WorkspaceModelsSection";
import { useWorkspaces } from "../store/workspaceStore";
import { RepositoryGeneral } from "../components/RepositorySettings";
import { BoardPage } from "../components/settings/BoardPage";
import type { RoleModels } from "../lib/roleModels";
import { withModelPart, type WorkspaceModels } from "../lib/workspaceModels";
import { renderUi, screen, waitFor } from "./render";
import { tauri } from "./tauri";

const WS = "ws-cl4";
const APP: RoleModels = {
  claude: { builder: "opus", challenger: "sonnet" },
  codex: { challenger: "gpt-5.5", challengerReasoning: "medium" },
};

function withWorkspace(models: WorkspaceModels | null) {
  useWorkspaces.setState({
    activeId: WS,
    workspaces: [
      {
        id: WS,
        name: "atelier",
        cwd: "/tmp/atelier",
        createdAt: 1,
        lastOpenedAt: 1,
        openFiles: [],
        activeFile: null,
        models,
      },
    ],
  } as never);
}

const modelsNow = () => useWorkspaces.getState().workspaces[0].models ?? null;

describe("CL-4: models per workspace", () => {
  // 1.174.0 (DS4, scene 7): one AI at a time, as "Only in <project>".
  it("is Only in <project>, one AI at a time, and says which rows follow Every project", () => {
    withWorkspace({
      claude: { challenger: "claude-fable-5-1" },
      codex: { challengerReasoning: "low" },
      cliDefault: ["claude.builder"],
    });
    renderUi(
      <>
        <WorkspaceModelsSection app={APP} vendor="claude" />
        <WorkspaceModelsSection app={APP} vendor="codex" />
      </>,
    );
    expect(screen.getAllByRole("heading", { name: "Only in atelier" })).toHaveLength(2);
    // Only Codex's Builder sets nothing of its own here.
    expect(screen.getAllByText("Follows Every project.")).toHaveLength(1);
    // The forced field shows its choice.
    expect(
      (screen.getByRole("textbox", { name: "Builder model (Claude) for this workspace" }) as HTMLInputElement).value,
    ).toBe("The tool's default");
    // 1.169.0 (A1): an effort for both vendors.
    expect(screen.getAllByRole("combobox").map((s) => s.getAttribute("aria-label"))).toEqual([
      "Builder effort (Claude) for this workspace",
      "Reviewer effort (Claude) for this workspace",
      "Builder effort (Codex) for this workspace",
      "Reviewer effort (Codex) for this workspace",
    ]);
  });

  it("1.169.0: offers the catalog's levels for the model and keeps a saved minimal, shown as not on it", async () => {
    tauri().fixture("model_catalog_get", {
      claude: { efforts: ["low", "medium", "high", "xhigh", "max"], models: [{ id: "opus", label: "Opus (latest)" }] },
      codex: {
        efforts: ["low", "medium", "high"],
        models: [{ id: "gpt-6-astra", label: "GPT-6-Astra", efforts: ["low", "medium", "high", "xhigh"] }],
      },
      codexFromCli: true,
      fileFrom: "bundled",
    });
    withWorkspace({ claude: {}, codex: { builder: "gpt-6-astra", builderReasoning: "minimal" } });
    renderUi(
      <>
        <WorkspaceModelsSection app={{ claude: {}, codex: {} }} vendor="claude" />
        <WorkspaceModelsSection app={{ claude: {}, codex: {} }} vendor="codex" />
      </>,
    );
    const effort = (await screen.findByRole("combobox", { name: "Builder effort (Codex) for this workspace" })) as HTMLSelectElement;
    await waitFor(() =>
      expect([...effort.options].map((o) => o.textContent)).toEqual([
        "Every project's",
        "The tool's default",
        "low",
        "medium",
        "high",
        "xhigh",
        "minimal (not on this model)",
      ]),
    );
    expect(effort.value).toBe("minimal");
    expect(
      screen.getByText(/minimal isn't available on gpt-6-astra, so it runs at that model's own default\./),
    ).toBeTruthy();
    // Read once for the whole section.
    expect(tauri().callsOf("model_catalog_get")).toHaveLength(1);
    const claude = screen.getByRole("combobox", { name: "Builder effort (Claude) for this workspace" }) as HTMLSelectElement;
    expect([...claude.options].map((o) => o.value)).toEqual(["", "The tool's default", "low", "medium", "high", "xhigh", "max"]);
  });

  it("writes a reasoning choice through workspace_set_models, keeping the rest", async () => {
    withWorkspace({ claude: { builder: "sonnet" }, codex: {} });
    const { tauri, user } = renderUi(<WorkspaceModelsSection app={APP} vendor="codex" />, {
      fixtures: { workspace_set_models: null },
    });
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Builder effort (Codex) for this workspace" }),
      "high",
    );
    await waitFor(() => expect(tauri.callsOf("workspace_set_models")).toHaveLength(1));
    expect(tauri.callsOf("workspace_set_models")[0].args).toEqual({
      id: WS,
      models: { claude: { builder: "sonnet" }, codex: { builderReasoning: "high" } },
    });
    expect(tauri.callsOf("settings_set")).toHaveLength(0);
  });

  it("CLI default on an effort forces it over the app row", async () => {
    withWorkspace(null);
    const { tauri, user } = renderUi(<WorkspaceModelsSection app={APP} vendor="codex" />, {
      fixtures: { workspace_set_models: null },
    });
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Reviewer effort (Codex) for this workspace" }),
      "The tool's default",
    );
    await waitFor(() => expect(tauri.callsOf("workspace_set_models")).toHaveLength(1));
    expect(tauri.callsOf("workspace_set_models")[0].args).toEqual({
      id: WS,
      models: { claude: {}, codex: {}, cliDefault: ["codex.challengerReasoning"] },
    });
  });

  it("Every project's clears the last field, and the key with it", async () => {
    withWorkspace({ claude: {}, codex: { builderReasoning: "high" } });
    const { tauri, user } = renderUi(<WorkspaceModelsSection app={APP} vendor="codex" />, {
      fixtures: { workspace_set_models: null },
    });
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Builder effort (Codex) for this workspace" }),
      "",
    );
    await waitFor(() => expect(tauri.callsOf("workspace_set_models")).toHaveLength(1));
    expect(tauri.callsOf("workspace_set_models")[0].args).toEqual({ id: WS, models: null });
  });

  it("F1: two quick edits both land, in order, while the first is still saving", async () => {
    withWorkspace(null);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let first = true;
    const { tauri } = renderUi(<WorkspaceModelsSection app={APP} vendor="codex" />, {
      fixtures: {
        workspace_set_models: async () => {
          if (first) {
            first = false;
            await gate;
          }
          return null;
        },
      },
    });
    const store = useWorkspaces.getState();
    const a = store.updateModels(WS, (m) => withModelPart(m, "claude", "builder", "model", "opus"));
    const b = store.updateModels(WS, (m) => withModelPart(m, "codex", "builder", "reasoning", "low"));
    // The store has both at once, before any save returned.
    expect(modelsNow()).toEqual({ claude: { builder: "opus" }, codex: { builderReasoning: "low" } });
    release();
    await Promise.all([a, b]);
    const sent = tauri.callsOf("workspace_set_models").map((c) => c.args.models);
    expect(sent).toEqual([
      { claude: { builder: "opus" }, codex: {} },
      { claude: { builder: "opus" }, codex: { builderReasoning: "low" } },
    ]);
    expect(modelsNow()).toEqual({ claude: { builder: "opus" }, codex: { builderReasoning: "low" } });
  });

  it("F5: after a refused edit the workspaces are reloaded from the backend", async () => {
    withWorkspace({ claude: { builder: "sonnet" }, codex: {} });
    const onDisk = {
      workspaces: [
        {
          id: WS,
          name: "atelier",
          cwd: "/tmp/atelier",
          createdAt: 1,
          lastOpenedAt: 1,
          openFiles: [],
          activeFile: null,
          models: { claude: { builder: "claude-opus-5" }, codex: {} },
        },
      ],
      activeWorkspaceId: WS,
    };
    const { tauri, user } = renderUi(<WorkspaceModelsSection app={APP} vendor="codex" />, {
      fixtures: {
        workspace_set_models: () => {
          throw new Error("disk full");
        },
        workspace_list: onDisk,
        workspace_cwd_exists: true,
      },
    });
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Builder effort (Codex) for this workspace" }),
      "high",
    );
    await waitFor(() => expect(tauri.callsOf("workspace_list").length).toBeGreaterThan(0));
    // What the backend holds, not a local guess.
    await waitFor(() => expect(modelsNow()).toEqual({ claude: { builder: "claude-opus-5" }, codex: {} }));
  });

  it("with no project open, there is no Only in … section", () => {
    useWorkspaces.setState({ activeId: null, workspaces: [] } as never);
    renderUi(<WorkspaceModelsSection app={APP} vendor="claude" />);
    expect(screen.queryByRole("heading", { name: /^Only in/ })).toBeNull();
  });

  // 1.169.0 (A2): the team's suggestions (`team_models_get`), edited
  // through the definition's queue.
  it("A2: shows the team's suggestion under the workspace's rows and publishes a change, unknown keys kept", async () => {
    let models: unknown = { codex: { builder: "gpt-6-luna", future: 2 }, later: 1 };
    tauri().fixture("team_models_get", () => ({ shared: true, readOnly: false, models }));
    tauri().fixture("workspace_definition_save", (args: Record<string, unknown>) => {
      models = (args.draft as { models: unknown }).models;
      return {};
    });
    withWorkspace(null);
    const { user } = renderUi(
      <>
        <WorkspaceModelsSection app={APP} vendor="codex" />
        <TeamModelsPage workspaceId={WS} />
      </>,
    );
    expect(await screen.findByText(/^The team suggests gpt-6-luna \(Project › General\)\.$/i)).toBeTruthy();
    const ownModel = screen.getByRole("textbox", { name: "Builder model (Codex) for this workspace" }) as HTMLInputElement;
    expect(ownModel.placeholder).toBe("gpt-6-luna (team)");
    const effort = screen.getByRole("combobox", { name: "Team's Builder effort (Codex)" }) as HTMLSelectElement;
    await user.selectOptions(effort, "xhigh");
    await waitFor(() => expect(tauri().callsOf("workspace_definition_save")).toHaveLength(1));
    const args = tauri().callsOf("workspace_definition_save")[0]!.args;
    expect(args.base).toEqual({ models: { codex: { builder: "gpt-6-luna", future: 2 }, later: 1 } });
    expect(args.draft).toEqual({ models: { codex: { builder: "gpt-6-luna", builderReasoning: "xhigh", future: 2 }, later: 1 } });
    await waitFor(() => expect(screen.getByText(/^The team suggests .* · xhigh \(Project › General\)\.$/)).toBeTruthy());
    // The workspace's own effort now names what its first choice picks.
    const own = screen.getByRole("combobox", { name: "Builder effort (Codex) for this workspace" }) as HTMLSelectElement;
    expect(own.options[0]!.textContent).toBe("Use the team's");
  });

  // 1.169.0 walk: two quick edits a second apart lost the first.
  it("A2: two quick edits each build on the one before, to different keys and to the same key", async () => {
    let models: unknown = { codex: { builder: "gpt-6-luna", builderReasoning: "high" } };
    tauri().fixture("team_models_get", () => ({ shared: true, readOnly: false, models }));
    tauri().fixture("workspace_definition_save", async (args: Record<string, unknown>) => {
      await new Promise((r) => setTimeout(r, 20));
      models = (args.draft as { models: unknown }).models;
      return {};
    });
    withWorkspace(null);
    renderUi(<TeamModelsPage workspaceId={WS} />);
    await screen.findByRole("combobox", { name: "Team's Builder effort (Codex)" });
    const { useTeamModelsStore } = await import("../store/teamModelsStore");
    const { withTeamPart } = await import("../lib/workspaceModels");
    const save = useTeamModelsStore.getState().save;
    // Different keys: the model cleared, then the effort changed — not awaited.
    const a = save(WS, (m) => withTeamPart(m, "codex", "builder", "model", ""));
    const b = save(WS, (m) => withTeamPart(m, "codex", "builder", "reasoning", "xhigh"));
    await Promise.all([a, b]);
    expect(models).toEqual({ codex: { builderReasoning: "xhigh" } });
    // The same key twice: the later wins, built on the earlier.
    const c = save(WS, (m) => withTeamPart(m, "codex", "builder", "reasoning", "low"));
    const d = save(WS, (m) => withTeamPart(m, "codex", "builder", "reasoning", "max"));
    await Promise.all([c, d]);
    expect(models).toEqual({ codex: { builderReasoning: "max" } });
    const drafts = tauri().callsOf("workspace_definition_save").map((call) => (call.args.base as { models: unknown }).models);
    expect(drafts[1]).toEqual({ codex: { builderReasoning: "high" } });
  });

  it("A2: clearing the last suggestion removes the key (null)", async () => {
    tauri().fixture("team_models_get", { shared: true, readOnly: false, models: { claude: { builder: "claude-opus-5-5" } } });
    tauri().fixture("workspace_definition_save", {});
    withWorkspace(null);
    const { user } = renderUi(<TeamModelsPage workspaceId={WS} />);
    const field = (await screen.findByRole("textbox", { name: "Team's Builder model (Claude)" })) as HTMLInputElement;
    await waitFor(() => expect(field.value).toBe("claude-opus-5-5"));
    await user.clear(field);
    await user.tab();
    await waitFor(() => expect(tauri().callsOf("workspace_definition_save")).toHaveLength(1));
    expect(tauri().callsOf("workspace_definition_save")[0]!.args.draft).toEqual({ models: null });
  });

  it("A2: read-only for whoever can't push, and absent without a shared definition", async () => {
    tauri().fixture("team_models_get", { shared: true, readOnly: true, models: { claude: { builder: "claude-opus-5-5" } } });
    withWorkspace(null);
    renderUi(<TeamModelsPage workspaceId={WS} />);
    const field = (await screen.findByRole("textbox", { name: "Team's Builder model (Claude)" })) as HTMLInputElement;
    expect(field.disabled).toBe(true);
    expect(screen.getAllByText("Only someone who can push to this repository can change these.").length).toBe(4);
  });

  it("A2: no shared definition, no team rows", async () => {
    withWorkspace(null);
    renderUi(
      <>
        <TeamModelsSection workspaceId={WS} onOpen={() => {}} />
        <TeamModelsPage workspaceId={WS} />
      </>,
    );
    await waitFor(() => expect(tauri().callsOf("team_models_get").length).toBeGreaterThan(0));
    expect(screen.queryByText("Models suggested for the team")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  // 1.174.0 (DS4, scene 8): General's section, one row per AI.
  it("General: one summary row per AI, Change… or Suggest…, which opens the sub-page", async () => {
    tauri().fixture("team_models_get", { shared: true, readOnly: false, models: { claude: { builder: "claude-sonnet-x", builderReasoning: "medium" } } });
    withWorkspace(null);
    let opened = 0;
    const { user } = renderUi(<TeamModelsSection workspaceId={WS} onOpen={() => opened++} />);
    expect(await screen.findByText("Builder: claude-sonnet-x · medium · Reviewer: none suggested")).toBeTruthy();
    expect(screen.getByText("None suggested")).toBeTruthy();
    expect(
      screen.getByText("Each teammate's cards start with these unless their card or their own choice for this project says otherwise."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Change…" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Suggest…" }));
    expect(opened).toBe(1);
  });

  it("General draws it under where the cards live, and Change… opens its sub-page", async () => {
    tauri().fixture("team_models_get", { shared: true, readOnly: false, models: { codex: { builder: "gpt-6-luna" } } });
    withWorkspace(null);
    const r = renderUi(<RepositoryGeneral workspaceId={WS} board={<BoardPage scope="repository" workspaceId={WS} />} />, {
      fixtures: {
        workspace_definition_get: null,
        project_config_get: {
          schemaVersion: 2,
          targetBranch: "main",
          versionFiles: [],
          installScript: null,
          verifyPipeline: null,
          createdAt: 0,
          updatedAt: 0,
        },
        project_review_get: { selfCheck: true, reviewChecklist: [] },
        worktree_settings_get: {},
      },
    });
    r.tauri.allowUnhandled();
    const team = await screen.findByRole("heading", { name: "Models suggested for the team" });
    const board = screen.getByRole("heading", { name: "Where the cards live" });
    expect(board.compareDocumentPosition(team) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await r.user.click(screen.getByRole("button", { name: "Change…" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Models suggested for the team" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Team's Builder effort (Codex)" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Where the cards live" })).toBeNull();
    await r.user.click(screen.getByRole("button", { name: "General" }));
    expect(await screen.findByRole("heading", { name: "Where the cards live" })).toBeTruthy();
  });

  it("DS4 round 1: a landing on General closes its team-models sub-page, the draft kept", async () => {
    tauri().fixture("team_models_get", { shared: true, readOnly: false, models: { codex: { builder: "gpt-6-luna" } } });
    withWorkspace(null);
    const { FoundRow } = await import("../components/ux");
    const at = (token: string | null, nonce: number) => (
      <FoundRow token={token} nonce={nonce} marked={token !== null} onArrived={() => {}} onMissing={() => {}}>
        <RepositoryGeneral workspaceId={WS} board={<BoardPage scope="repository" workspaceId={WS} />} />
      </FoundRow>
    );
    const r = renderUi(at(null, 0), {
      fixtures: {
        workspace_definition_get: null,
        project_config_get: {
          schemaVersion: 2,
          targetBranch: "main",
          versionFiles: [],
          installScript: null,
          verifyPipeline: null,
          createdAt: 0,
          updatedAt: 0,
        },
        project_review_get: { selfCheck: true, reviewChecklist: [] },
        worktree_settings_get: {},
      },
    });
    r.tauri.allowUnhandled();
    await screen.findByRole("heading", { name: "Models suggested for the team" });
    await r.user.click(screen.getByRole("button", { name: "Change…" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Models suggested for the team" })).toBeTruthy();
    r.rerender(at("Name", 1));
    expect(await screen.findByRole("heading", { level: 1, name: "General" })).toBeTruthy();
    expect(await screen.findByText("Found here")).toBeTruthy();
  });
});
