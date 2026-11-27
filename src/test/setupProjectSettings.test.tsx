// OB-13 (ONBOARDING_SPEC §5 step 9): Setup's "How Plyloft builds “lyra”",
// rendered inside Setup against the stubbed backend — the facts in plain
// words with the "none yet" sentences, `Looks right` saving through
// `project_config_set` (no sheet) and moving on, the quiet `Change` form
// (branch, checks on/off, the pointer to Settings), the branch question when
// Rust found no branch to use (never a silent `main`), the branch kept from
// step 8 passed in, a shared definition read-only, a saved config done with
// `Change`, a project step 8 must fix first, and the fast checklist's row.
import { afterEach, describe, expect, it } from "vitest";
import { SetupOverlay } from "../components/SetupOverlay";
import { useSetup } from "../store/setupStore";
import { useWorkspaces, type Workspace } from "../store/workspaceStore";
import { useFirstProject } from "../store/firstProjectStore";
import { DEFAULT_SETTINGS, useSettings, type Settings } from "../store/settingsStore";
import type { ProjectConfig, SetupConfigView, TryCommandView } from "../ipc";
import type { SetupStepId } from "../lib/settingsShape";
import { act, nextFrame, renderUi, screen, waitFor, within } from "./render";
import { tauri } from "./tauri";

afterEach(() => {
  act(() => useSetup.setState({ open: false, step: null }));
});

const lyra: Workspace = {
  id: "ws-lyra",
  name: "lyra",
  cwd: "/Users/me/Projects/lyra",
  createdAt: 1,
  lastOpenedAt: 1,
  openFiles: [],
  activeFile: null,
};

const config = (over: Partial<ProjectConfig> = {}): ProjectConfig => ({
  schemaVersion: 2,
  targetBranch: "main",
  versionFiles: [],
  installScript: null,
  verifyPipeline: null,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

const reading = (over: Partial<SetupConfigView> = {}): SetupConfigView => ({
  state: "proposal",
  config: config(),
  branches: ["main"],
  suggestedBranch: null,
  branchFrom: "head",
  head: "branch",
  headBranch: "main",
  detectedVerify: null,
  version: null,
  readOnly: false,
  ...over,
});

const VERIFY = [{ kind: "script" as const, path: "scripts/verify.sh" }];

interface Opts {
  view?: SetupConfigView;
  workspaces?: Workspace[];
  level?: "guided" | "fast";
  step?: SetupStepId;
  /** Workspace ids with a saved config at the start. */
  configured?: string[];
  saveFails?: string;
  /** Try it: what `project_try_command_get` answers. */
  tryView?: TryCommandView;
  /** Try it: `project_try_command_save` refuses with this. */
  trySaveFails?: string;
}

const tryView = (over: Partial<TryCommandView> = {}): TryCommandView => ({
  command: null,
  approved: true,
  shared: false,
  readOnly: false,
  hasConfig: false,
  detection: { kind: "none" },
  ...over,
});

async function openStep(o: Opts = {}) {
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    onboarding: { ...DEFAULT_SETTINGS.onboarding, level: o.level ?? "guided" },
    projects: { ...DEFAULT_SETTINGS.projects, folder: "~/Projects" },
  };
  const list = o.workspaces ?? [lyra];
  const saved = new Map<string, ProjectConfig>((o.configured ?? []).map((id) => [id, config()]));
  act(() => {
    useSettings.setState({ settings, loaded: true });
    useWorkspaces.setState({ workspaces: [...list], activeId: list[0]?.id ?? null });
  });
  const r = renderUi(<SetupOverlay />, {
    fixtures: {
      settings_set: ({ settings: next }: Record<string, unknown>) => next,
      dependency_doctor: {
        tools: [
          { id: "git", found: true, versionOk: true },
          { id: "claude", found: true, versionOk: true },
          { id: "gh", found: false },
        ],
        allRequiredOk: true,
        aiReady: true,
        gitWorks: true,
        gitIdentity: { name: "Me", email: "me@example.com" },
        whisperModel: { model: "small", present: false, path: null, detail: "Not downloaded." },
      },
      team_work_mode: { mode: "solo", chosen: true },
      team_status: { teamRepo: null, teamName: null, hasClone: false, error: null, workspaces: [] },
      project_config_list: () => [...saved.entries()],
      project_config_get: ({ workspaceId }: Record<string, unknown>) => saved.get(String(workspaceId)) ?? null,
      project_config_set: ({ workspaceId, config: next }: Record<string, unknown>) => {
        if (o.saveFails) throw new Error(o.saveFails);
        saved.set(String(workspaceId), next as ProjectConfig);
        return null;
      },
      project_detect_for_setup: () => o.view ?? reading(),
      project_try_command_get: () => o.tryView ?? tryView(),
      project_try_command_save: ({ command }: Record<string, unknown>) => {
        if (o.trySaveFails) throw new Error(o.trySaveFails);
        return tryView({ ...o.tryView, command: (command as string | null) ?? null, approved: true, hasConfig: true });
      },
      // UX P-C: Ready reads the card copy's setup command for its set-up line.
      worktree_settings_get: {},
      project_inspect: { git: { kind: "branch", branch: "main", commit: "abc" }, branches: ["main"] },
      build_cache_status: null,
      workspace_list: () => ({ workspaces: [...list], activeWorkspaceId: list[0]?.id ?? null }),
      workspace_set_active: null,
      workspace_cwd_exists: true,
    },
  });
  act(() => useSetup.getState().openSetup("rerun", o.step ?? "config"));
  await nextFrame();
  return { ...r, saved };
}

const stepTitle = () => document.querySelector(".ux-setup-steptitle")?.textContent;
const footer = () => document.querySelector(".ux-setup-foot") as HTMLElement;
const footerButton = (name: string) => waitFor(() => within(footer()).getByRole("button", { name }));
const content = () => document.querySelector(".ux-setup-content") as HTMLElement;
const stepList = () => screen.getByRole("navigation", { name: "Setup steps" });
const fact = (label: string) => {
  const dt = within(content()).getByText(label, { selector: "dt" });
  return dt.parentElement!.querySelector("dd")!.textContent;
};

describe("Step 9: a project read for the first time", () => {
  it("shows the facts in plain words — an empty project's none-yet sentences — and Looks right saves and moves on", async () => {
    const { user, saved } = await openStep();
    await waitFor(() => expect(stepTitle()).toBe("How Plyloft builds “lyra”"));
    await waitFor(() =>
      expect(content().textContent).toContain("Plyloft looked at your project. Check that this sounds right."),
    );
    expect(fact("Cards start from")).toBe(
      "main. Each card gets its own copy of main, and its result is merged back into main.",
    );
    expect(fact("Checks before shipping")).toBe(
      "None yet. Cards ship without checks; you can add them later in Settings.",
    );
    expect(fact("Version number")).toBe("No version file. Plyloft won't change a version.");
    expect(fact("After shipping")).toBe("Nothing runs.");
    // Details carries the file's own fields.
    expect(content().textContent).toContain("Checks before shipping: empty");
    // No sheet: one press writes Plyloft's own data.
    await user.click(await footerButton("Looks right"));
    await waitFor(() => expect(tauri().callsOf("project_config_set")).toHaveLength(1));
    const call = tauri().callsOf("project_config_set")[0].args as { workspaceId: string; config: ProjectConfig };
    expect(call.workspaceId).toBe("ws-lyra");
    expect(call.config.targetBranch).toBe("main");
    expect(call.config.verifyPipeline).toBeNull();
    expect(saved.has("ws-lyra")).toBe(true);
    expect(screen.queryByRole("dialog", { name: /sheet/i })).toBeNull();
    await waitFor(() => expect(stepTitle()).toBe("Plyloft is ready"));
    // The list is read again: step 9 is done.
    await waitFor(() =>
      expect(within(stepList()).getByRole("button", { name: /Project settings/ }).textContent).toContain("Done"),
    );
  });

  it("names the version, the checks and what runs after shipping when the project has them", async () => {
    await openStep({
      view: reading({
        config: config({
          versionFiles: [{ path: "package.json", kind: "package_json" }],
          verifyPipeline: VERIFY,
          installScript: "scripts/install.sh",
        }),
        detectedVerify: VERIFY,
        version: "1.4.2",
      }),
    });
    await waitFor(() => expect(fact("Version number")).toBe("Kept in package.json (1.4.2). Plyloft raises it when you release."));
    expect(fact("Checks before shipping")).toBe("scripts/verify.sh runs before a card can ship.");
    expect(fact("After shipping")).toBe("scripts/install.sh runs on this Mac.");
  });

  it("passes the branch step 8 kept for a detached HEAD", async () => {
    act(() => useFirstProject.getState().setTargetBranch("ws-lyra", "release"));
    await openStep({ view: reading({ config: config({ targetBranch: "release" }), branchFrom: "chosen" }) });
    await waitFor(() => expect(tauri().callsOf("project_detect_for_setup").length).toBeGreaterThan(0));
    expect(tauri().callsOf("project_detect_for_setup")[0].args).toEqual({
      workspaceId: "ws-lyra",
      chosenBranch: "release",
    });
    await waitFor(() => expect(fact("Cards start from")).toContain("release. Each card"));
    act(() => useFirstProject.setState({ targetBranch: {} }));
  });

  it("Change opens the inline form: the branch, checks on with the detected script, and the pointer to Settings", async () => {
    const { user } = await openStep({ view: reading({ branches: ["main", "dev"], detectedVerify: VERIFY }) });
    await user.click(await waitFor(() => within(content()).getByRole("button", { name: "Change" })));
    expect(content().textContent).toContain(
      "More settings are in Settings › Cards › Building and checking after setup.",
    );
    await user.selectOptions(within(content()).getByRole("combobox", { name: "Cards start from" }), "dev");
    const checks = within(content()).getByRole("switch");
    expect(content().textContent).toContain("Run scripts/verify.sh before a card can ship");
    await user.click(checks);
    // The facts follow the form.
    expect(fact("Cards start from")).toContain("dev. Each card gets its own copy of dev");
    expect(fact("Checks before shipping")).toBe("scripts/verify.sh runs before a card can ship.");
    await user.click(await footerButton("Looks right"));
    await waitFor(() => expect(tauri().callsOf("project_config_set")).toHaveLength(1));
    const saved = (tauri().callsOf("project_config_set")[0].args as { config: ProjectConfig }).config;
    expect(saved.targetBranch).toBe("dev");
    expect(saved.verifyPipeline).toEqual(VERIFY);
  });

  it("a project with no check script says so in the form (no switch to turn on)", async () => {
    const { user } = await openStep();
    await user.click(await waitFor(() => within(content()).getByRole("button", { name: "Change" })));
    expect(within(content()).queryByRole("switch")).toBeNull();
    expect(content().textContent).toContain("Plyloft found no check script in this project.");
  });

  it("a failed save says so and keeps the step", async () => {
    const { user } = await openStep({ saveFails: "disk full" });
    await user.click(await footerButton("Looks right"));
    await waitFor(() => expect(content().textContent).toContain("Plyloft couldn't save these settings."));
    expect(stepTitle()).toBe("How Plyloft builds “lyra”");
  });
});

describe("Step 9: no branch to use asks (C10)", () => {
  it("a detached HEAD without main asks which branch, then saves the answer", async () => {
    const { user } = await openStep({
      view: reading({
        state: "needsBranch",
        config: config({ targetBranch: "" }),
        branches: ["trunk", "master"],
        suggestedBranch: "master",
        branchFrom: null,
        head: "detached",
        headBranch: null,
      }),
    });
    await waitFor(() => expect(content().textContent).toContain("“lyra” isn't on a branch right now."));
    expect(content().textContent).toContain("Cards start from a branch and are merged back into it. Which one?");
    const select = within(content()).getByRole("combobox", { name: "Cards start from" }) as HTMLSelectElement;
    expect(select.value).toBe("master");
    // The form is open already; there is no separate Change.
    expect(within(content()).queryByRole("button", { name: "Change" })).toBeNull();
    await user.selectOptions(select, "trunk");
    await user.click(await footerButton("Looks right"));
    await waitFor(() => expect(tauri().callsOf("project_config_set")).toHaveLength(1));
    expect((tauri().callsOf("project_config_set")[0].args as { config: ProjectConfig }).config.targetBranch).toBe(
      "trunk",
    );
  });
});

describe("Step 9: settings that are already there", () => {
  it("a shared definition is read-only and done: no Change, Continue writes nothing", async () => {
    const { user } = await openStep({
      view: reading({ state: "shared", readOnly: true, config: config({ verifyPipeline: VERIFY }) }),
      configured: ["ws-lyra"],
    });
    await waitFor(() => expect(content().textContent).toContain("This project's settings come from its repository."));
    expect(fact("Checks before shipping")).toBe("scripts/verify.sh runs before a card can ship.");
    expect(within(content()).queryByRole("button", { name: "Change" })).toBeNull();
    expect(within(content()).queryByRole("combobox")).toBeNull();
    await waitFor(() =>
      expect(within(stepList()).getByRole("button", { name: /Project settings/ }).textContent).toContain("Done"),
    );
    await user.click(await footerButton("Continue"));
    await waitFor(() => expect(stepTitle()).toBe("Plyloft is ready"));
    expect(tauri().callsOf("project_config_set")).toHaveLength(0);
  });

  it("a shared definition not on this Mac yet waits, and reads again when its refresh lands", async () => {
    await openStep({ view: reading({ state: "shared", readOnly: true, config: null }) });
    await waitFor(() => expect(content().textContent).toContain("Plyloft is reading them from the repository…"));
    const before = tauri().callsOf("project_detect_for_setup").length;
    await waitFor(() => expect(tauri().listeners("workspace-definition://refreshed")).toBeGreaterThan(0));
    tauri().fixture("project_detect_for_setup", reading({ state: "shared", readOnly: true, config: config() }));
    act(() => tauri().emit("workspace-definition://refreshed", { workspaceId: "ws-lyra" }));
    await waitFor(() => expect(tauri().callsOf("project_detect_for_setup").length).toBeGreaterThan(before));
    await waitFor(() => expect(fact("Cards start from")).toContain("main. Each card"));
  });

  it("a saved config is done, shows its facts, and Change turns the primary into Save", async () => {
    const { user } = await openStep({
      view: reading({ state: "existing", branches: ["main", "dev"], config: config() }),
      configured: ["ws-lyra"],
    });
    await waitFor(() => expect(content().textContent).toContain("These are the settings Plyloft has for “lyra”."));
    await waitFor(() =>
      expect(within(stepList()).getByRole("button", { name: /Project settings/ }).textContent).toContain("Done"),
    );
    await footerButton("Continue");
    await user.click(within(content()).getByRole("button", { name: "Change" }));
    await user.selectOptions(within(content()).getByRole("combobox", { name: "Cards start from" }), "dev");
    await user.click(await footerButton("Save"));
    await waitFor(() => expect(tauri().callsOf("project_config_set")).toHaveLength(1));
    expect((tauri().callsOf("project_config_set")[0].args as { config: ProjectConfig }).config.targetBranch).toBe("dev");
  });
});

describe("Step 9: before there is a project to set up", () => {
  it("a project without a saved version is step 8's to fix", async () => {
    const { user } = await openStep({ view: reading({ state: "noCommit", config: null, branches: [] }) });
    await waitFor(() =>
      expect(content().textContent).toContain(
        "“lyra” has no saved version yet, so cards have nothing to start from. Save its first version in First project.",
      ),
    );
    await user.click(await footerButton("Go to First project"));
    await waitFor(() => expect(stepTitle()).toBe("Your first project"));
  });

  it("with no project at all, the step says to add one and never reads", async () => {
    const { user } = await openStep({ workspaces: [] });
    await waitFor(() =>
      expect(content().textContent).toContain("Add a project first. Plyloft sets up how it builds a project once it's in."),
    );
    expect(tauri().callsOf("project_detect_for_setup")).toHaveLength(0);
    await user.click(await footerButton("Add a project"));
    await waitFor(() => expect(stepTitle()).toBe("Your first project"));
  });
});

describe("Just the essentials: the Project settings row", () => {
  it("says the project isn't set up for builds yet, and Set up opens the step", async () => {
    const { user } = await openStep({ level: "fast", step: "ready" });
    await user.click(await footerButton("Back"));
    const row = (label: string) =>
      screen.getByText(label, { selector: ".ux-row-label, .ux-row-label *" }).closest(".ux-row") as HTMLElement;
    await waitFor(() => expect(within(row("Project settings")).getByText("“lyra” isn't set up for builds yet")).toBeTruthy());
    await user.click(within(row("Project settings")).getByRole("button", { name: "Set up" }));
    await waitFor(() => expect(stepTitle()).toBe("How Plyloft builds “lyra”"));
  });
});

// ── Try it (TRY_IT_SPEC §3.3): the line about how the app starts ───────

const NPM_DEV = { kind: "packageScript" as const, command: "npm run dev", script: "dev", packageManager: "npm" as const };

describe("Step 9: how Plyloft will start your app", () => {
  it("states the detected command, and Looks right keeps it after the settings", async () => {
    const { user } = await openStep({ tryView: tryView({ detection: NPM_DEV }) });
    await waitFor(() => expect(content().textContent).toContain('Plyloft will start your app with "npm run dev".'));
    await user.click(await footerButton("Looks right"));
    await waitFor(() => expect(tauri().callsOf("project_try_command_save")).toHaveLength(1));
    expect(tauri().callsOf("project_try_command_save")[0].args).toEqual({ workspaceId: "ws-lyra", command: "npm run dev" });
    // The settings went in first: the command is kept with them.
    const order = tauri().calls.map((c) => c.cmd).filter((c) => c === "project_config_set" || c === "project_try_command_save");
    expect(order).toEqual(["project_config_set", "project_try_command_save"]);
  });

  it("Change types another command, which the step then keeps", async () => {
    const { user } = await openStep({ tryView: tryView({ detection: NPM_DEV }) });
    await user.click(await waitFor(() => within(content()).getByRole("button", { name: "Change how your app starts" })));
    const field = within(content()).getByRole("textbox", { name: "How to start your app" });
    await user.clear(field);
    await user.type(field, "pnpm run dev{Enter}");
    await waitFor(() => expect(content().textContent).toContain('Plyloft will start your app with "pnpm run dev".'));
    await user.click(await footerButton("Looks right"));
    await waitFor(() => expect(tauri().callsOf("project_try_command_save")).toHaveLength(1));
    expect(tauri().callsOf("project_try_command_save")[0].args).toEqual({ workspaceId: "ws-lyra", command: "pnpm run dev" });
  });

  it("an empty Done clears the command instead of falling back to the suggestion", async () => {
    const { user } = await openStep({
      view: reading({ state: "existing" }),
      configured: ["ws-lyra"],
      tryView: tryView({ command: "npm run dev", hasConfig: true, detection: NPM_DEV }),
    });
    await user.click(await waitFor(() => within(content()).getByRole("button", { name: "Change how your app starts" })));
    await user.clear(within(content()).getByRole("textbox", { name: "How to start your app" }));
    await user.click(within(content()).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(content().textContent).toContain("No start command: Try it will ask how your app starts."));
    expect(content().textContent).not.toContain('with "npm run dev"');
    await user.click(await footerButton("Save"));
    await waitFor(() => expect(tauri().callsOf("project_try_command_save")).toHaveLength(1));
    expect(tauri().callsOf("project_try_command_save")[0].args).toEqual({ workspaceId: "ws-lyra", command: null });
  });

  it("a start command that fails after the settings saved says which part failed, and stays", async () => {
    const { user, saved } = await openStep({ tryView: tryView({ detection: NPM_DEV }), trySaveFails: "disk full" });
    await user.click(await footerButton("Looks right"));
    await waitFor(() =>
      expect(content().textContent).toContain("Plyloft saved the build settings, but not how your app starts."),
    );
    expect(saved.has("ws-lyra")).toBe(true);
    expect(content().textContent).not.toContain("Plyloft couldn't save these settings.");
    expect(stepTitle()).toBe("How Plyloft builds “lyra”");
  });

  it("a plain website keeps Change beside its sentence; Type it in is only where nothing was found", async () => {
    await openStep({ tryView: tryView({ detection: { kind: "staticSite" } as never }) });
    await waitFor(() => expect(content().textContent).toContain("This looks like a plain website"));
    expect(within(content()).getByRole("button", { name: "Change how your app starts" }).textContent).toBe("Change");
    expect(within(content()).queryByRole("button", { name: "Type how your app starts" })).toBeNull();
  });

  it("nothing found says so, and keeps nothing", async () => {
    const { user } = await openStep();
    await waitFor(() => expect(content().textContent).toContain("Plyloft couldn't tell how your app starts."));
    // 1.176.3: the sentence no longer points at a "Change" — the button says what it does.
    expect(content().textContent).not.toContain("tell it with Change");
    expect(within(content()).getByRole("button", { name: "Type how your app starts" }).textContent).toBe("Type it in");
    expect(within(content()).getAllByRole("button", { name: "Change" })).toHaveLength(1);
    await user.click(await footerButton("Looks right"));
    await waitFor(() => expect(tauri().callsOf("project_config_set")).toHaveLength(1));
    expect(tauri().callsOf("project_try_command_save")).toHaveLength(0);
  });

  it("on a saved config a suggestion waits for Use this, which turns the primary into Save", async () => {
    const { user } = await openStep({
      view: reading({ state: "existing" }),
      configured: ["ws-lyra"],
      tryView: tryView({ hasConfig: true, detection: NPM_DEV }),
    });
    await waitFor(() => expect(content().textContent).toContain('Plyloft found how your app starts: "npm run dev".'));
    await footerButton("Continue");
    await user.click(within(content()).getByRole("button", { name: "Use this" }));
    await user.click(await footerButton("Save"));
    await waitFor(() => expect(tauri().callsOf("project_try_command_save")).toHaveLength(1));
    expect(tauri().callsOf("project_try_command_save")[0].args).toEqual({ workspaceId: "ws-lyra", command: "npm run dev" });
  });

  it("a shared definition shows the repository's command and offers no change", async () => {
    await openStep({
      view: reading({ state: "shared", readOnly: true }),
      tryView: tryView({ command: "bin/rails server", shared: true, hasConfig: true, approved: false }),
    });
    await waitFor(() => expect(content().textContent).toContain('Plyloft will start your app with "bin/rails server".'));
    expect(within(content()).queryByRole("button", { name: "Change how your app starts" })).toBeNull();
  });
});
