// SL-4 — Settings › This repository › Build and release, the "Cards' copies"
// rows, on a workspace that shares no definition: this Mac's values shown,
// the setup command saved as it is committed, a path added on its sub-page
// (and a bad one refused with the reason), both through
// `worktree_settings_set`.
import { describe, expect, it } from "vitest";
import { RepositoryBuildRelease } from "../components/RepositorySettings";
import type { ProjectConfig, WorktreeSettings } from "../ipc";
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

function open(initial: WorktreeSettings) {
  let settings: WorktreeSettings = initial;
  const view = renderUi(<RepositoryBuildRelease workspaceId="ws" cwd="/r" />, {
    withToasts: true,
    fixtures: {
      workspace_definition_get: null,
      project_config_get: config,
      project_review_get: { selfCheck: true, reviewChecklist: [] },
      project_config_detect: { config, hasClaudeMd: false, notes: [] },
      workspace_definition_branches: { branches: ["main"], defaultBranch: "main", error: null, hasOrigin: true },
      worktree_settings_get: () => settings,
      worktree_settings_set: (args: Record<string, unknown>) => {
        if (args.worktreeCopy != null) settings = { ...settings, worktreeCopy: args.worktreeCopy as string[] };
        if (args.worktreeSetup != null) settings = { ...settings, worktreeSetup: (args.worktreeSetup as string) || null };
        return settings;
      },
    },
  });
  view.tauri.allowUnhandled();
  return view;
}

describe("the local Reset's confirmation", () => {
  // Owner decision 2026-09-30: a destructive confirm opens on Cancel.
  it("opens with focus on Cancel, so Enter deletes nothing", async () => {
    const { user, tauri } = open({});
    await user.click(await screen.findByRole("button", { name: "Reset" }));
    const sheet = screen.getByRole("dialog", { name: "Reset this repository's settings on this Mac?" });
    await waitFor(() => expect(document.activeElement).toBe(within(sheet).getByRole("button", { name: "Cancel" })));
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(tauri.callsOf("project_config_delete")).toHaveLength(0);
  });
});

describe("the Card worktrees rows", () => {
  it("show this Mac's settings and save a new setup command", async () => {
    const { user, tauri } = open({ worktreeCopy: [".env"], worktreeSetup: "npm ci" });
    const field = (await screen.findByRole("textbox", { name: "Before the Builder starts, run" })) as HTMLInputElement;
    await waitFor(() => expect(field.value).toBe("npm ci"));
    const row = screen.getByText("Files copied in").closest(".ux-row") ?? document.body;
    expect(within(row as HTMLElement).getByText("1 path")).toBeTruthy();
    await user.clear(field);
    await user.type(field, "pnpm install{Enter}");
    await waitFor(() => expect(tauri.callsOf("worktree_settings_set")).toHaveLength(1));
    expect(tauri.callsOf("worktree_settings_set")[0].args).toEqual({
      workspaceId: "ws",
      worktreeCopy: null,
      worktreeSetup: "pnpm install",
    });
  });

  it("clearing the setup command and tabbing away saves it, like any row (F9)", async () => {
    const { user, tauri } = open({ worktreeSetup: "npm ci" });
    const field = (await screen.findByRole("textbox", { name: "Before the Builder starts, run" })) as HTMLInputElement;
    await waitFor(() => expect(field.value).toBe("npm ci"));
    await user.clear(field);
    await user.tab();
    await waitFor(() => expect(tauri.callsOf("worktree_settings_set")).toHaveLength(1));
    expect(tauri.callsOf("worktree_settings_set")[0].args).toMatchObject({ workspaceId: "ws", worktreeSetup: "" });
    await waitFor(() => expect(screen.getByText(/^None — the Builder starts as soon as the card's copy is made\. Each card's copy has its own 10 ports/)).toBeTruthy());
  });

  it("a command this Mac hasn't allowed says so on its row (F7)", async () => {
    open({ worktreeSetup: "sleep 600 && echo teammate-setup", approvedSetup: null });
    expect(await screen.findByText(/hasn't been allowed on this Mac yet/)).toBeTruthy();
  });

  it("add a path on the sub-page, and refuse one outside the repository", async () => {
    const { user, tauri } = open({});
    await user.click(await screen.findByText("Files copied in"));
    const add = (await screen.findByRole("textbox", { name: "Add a path" })) as HTMLInputElement;
    await user.type(add, "../secrets{Enter}");
    expect(await screen.findByText("A path names something inside the repository: no . or .. in it.")).toBeTruthy();
    expect(tauri.callsOf("worktree_settings_set")).toHaveLength(0);
    await user.clear(add);
    await user.type(add, "apps/*/.env.local{Enter}");
    await waitFor(() => expect(tauri.callsOf("worktree_settings_set")).toHaveLength(1));
    expect(tauri.callsOf("worktree_settings_set")[0].args.worktreeCopy).toEqual(["apps/*/.env.local"]);
    await waitFor(() => expect(screen.getByText("apps/*/.env.local")).toBeTruthy());
  });
});
