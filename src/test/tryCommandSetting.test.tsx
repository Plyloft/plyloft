// Try it (TRY_IT_SPEC §3.3, §5), TI-1: Settings › This repository › Build and
// release › "How to start your app". The saved command in mono, else the
// detected suggestion with Use this, else Not set; Change opens a field under
// the row (Enter or Save); the scope line says where it lives (this Mac or everyone who opens
// the repo); a read-only repository offers no change. Every save goes through
// `project_try_command_save`.
import { describe, expect, it } from "vitest";
import { RepositoryBuildRelease } from "../components/RepositorySettings";
import type { ProjectConfig, TryCommandView } from "../ipc";
import { renderUi, screen, waitFor, within } from "./render";

const config: ProjectConfig = {
  schemaVersion: 2,
  targetBranch: "main",
  versionFiles: [],
  installScript: null,
  verifyPipeline: null,
  createdAt: 0,
  updatedAt: 0,
};

const NPM_DEV = { kind: "packageScript" as const, command: "npm run dev", script: "dev", packageManager: "npm" as const };

const tryView = (over: Partial<TryCommandView> = {}): TryCommandView => ({
  command: null,
  approved: true,
  shared: false,
  readOnly: false,
  hasConfig: true,
  detection: { kind: "none" },
  ...over,
});

function openSettings(initial: TryCommandView, extra: Record<string, unknown> = {}) {
  let current = initial;
  const view = renderUi(<RepositoryBuildRelease workspaceId="ws" cwd="/r" />, {
    withToasts: true,
    fixtures: {
      workspace_definition_get: null,
      project_config_get: config,
      project_review_get: { selfCheck: true, reviewChecklist: [] },
      project_config_detect: { config, hasClaudeMd: false, notes: [] },
      workspace_definition_branches: { branches: ["main"], defaultBranch: "main", error: null, hasOrigin: true },
      worktree_settings_get: {},
      project_try_command_get: () => current,
      project_try_command_save: ({ command }: Record<string, unknown>) => {
        current = { ...current, command: (command as string | null) ?? null, approved: true };
        return current;
      },
      ...extra,
    },
  });
  view.tauri.allowUnhandled();
  return view;
}

const row = async () => {
  const label = await screen.findByText("How to start your app");
  return label.closest(".ux-row") as HTMLElement;
};

describe("How to start your app", () => {
  it("offers the detected command with where it was found, and Use this saves it", async () => {
    const { user, tauri } = openSettings(tryView({ detection: NPM_DEV }));
    await waitFor(async () =>
      expect((await row()).textContent).toContain('Found in package.json: the "dev" script, run with npm.'),
    );
    expect((await row()).textContent).toContain("npm run dev");
    await user.click(within(await row()).getByRole("button", { name: "Use this" }));
    await waitFor(() => expect(tauri.callsOf("project_try_command_save")).toHaveLength(1));
    expect(tauri.callsOf("project_try_command_save")[0].args).toEqual({ workspaceId: "ws", command: "npm run dev" });
    await waitFor(async () =>
      expect((await row()).textContent).toContain("Saved for this repository on this Mac."),
    );
    expect(within(await row()).queryByRole("button", { name: "Use this" })).toBeNull();
  });

  it("shows a shared command, says it reaches everyone and that this Mac hasn't allowed it, and Change saves another", async () => {
    const { user, tauri } = openSettings(tryView({ command: "bin/rails server", shared: true, approved: false }));
    await waitFor(async () => expect((await row()).textContent).toContain("bin/rails server"));
    const text = (await row()).textContent ?? "";
    expect(text).toContain("Shared with everyone who opens the repository.");
    expect(text).toContain("It hasn't run on this Mac yet");
    await user.click(within(await row()).getByRole("button", { name: "Change" }));
    const field = screen.getByRole("textbox", { name: "Start command" });
    expect((field as HTMLInputElement).value).toBe("bin/rails server");
    await user.clear(field);
    await user.type(field, "bin/dev");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(tauri.callsOf("project_try_command_save")).toHaveLength(1));
    expect(tauri.callsOf("project_try_command_save")[0].args).toEqual({ workspaceId: "ws", command: "bin/dev" });
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Start command" })).toBeNull());
  });

  it("says Not set when nothing is found, and Enter in the field saves what was typed", async () => {
    const { user, tauri } = openSettings(tryView());
    await waitFor(async () => expect((await row()).textContent).toContain("Not set"));
    expect((await row()).textContent).toContain("Plyloft couldn't tell how this app starts.");
    await user.click(within(await row()).getByRole("button", { name: "Change" }));
    await user.type(screen.getByRole("textbox", { name: "Start command" }), "  python app.py {Enter}");
    await waitFor(() => expect(tauri.callsOf("project_try_command_save")).toHaveLength(1));
    expect(tauri.callsOf("project_try_command_save")[0].args).toEqual({ workspaceId: "ws", command: "python app.py" });
    await waitFor(async () => expect((await row()).textContent).toContain("python app.py"));
  });

  it("a read-only repository shows the command and offers no change", async () => {
    openSettings(tryView({ command: "npm start", shared: true, readOnly: true }));
    await waitFor(async () => expect((await row()).textContent).toContain("npm start"));
    expect((await row()).textContent).toContain("ask for write access to change it");
    expect(within(await row()).queryByRole("button")).toBeNull();
  });

  it("a saved command can be forgotten", async () => {
    const { user, tauri } = openSettings(tryView({ command: "npm run dev" }));
    await waitFor(async () => expect((await row()).textContent).toContain("npm run dev"));
    await user.click(within(await row()).getByRole("button", { name: "More for How to start your app" }));
    await user.click(await screen.findByRole("menuitem", { name: "Forget this command" }));
    await waitFor(() => expect(tauri.callsOf("project_try_command_save")).toHaveLength(1));
    expect(tauri.callsOf("project_try_command_save")[0].args).toEqual({ workspaceId: "ws", command: null });
    await waitFor(async () => expect((await row()).textContent).toContain("Not set"));
  });

  it("works with no build settings on this Mac yet: Use this saves it here", async () => {
    const { user, tauri } = openSettings(tryView({ hasConfig: false, detection: NPM_DEV }), { project_config_get: null });
    await waitFor(async () => expect((await row()).textContent).toContain("npm run dev"));
    expect((await row()).textContent).not.toContain("Set those up first");
    await user.click(within(await row()).getByRole("button", { name: "Use this" }));
    await waitFor(() => expect(tauri.callsOf("project_try_command_save")).toHaveLength(1));
    await waitFor(async () => expect((await row()).textContent).toContain("Saved for this repository on this Mac."));
  });

  it("a start command saved here and not published yet is marked on its row", async () => {
    const definition = { schemaVersion: 1, name: "LYRA", board: "local", integrationBranch: "main", versionFiles: [] };
    openSettings(tryView({ command: "npm start", shared: true }), {
      workspace_definition_get: {
        cache: { definition, branch: "main", author: "a", changedAt: null, pending: { tryCommand: "npm start" } },
        effective: definition,
        defaultBranch: "main",
        queue: {
          createDefinition: false,
          fields: { tryCommand: { pullRequest: { number: 77 } } },
          createPullRequest: null,
          lastError: null,
        },
        readOnly: false,
      },
    });
    await waitFor(async () =>
      expect((await row()).textContent).toContain("Changed here, waiting in pull request #77. It works on this Mac already."),
    );
  });
});
