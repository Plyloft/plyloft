// OB-12 (ONBOARDING_SPEC §5 steps 7 and 8): Setup's "Your first project"
// and its Projects folder row (1.175.0 F2: the step "Where your projects
// live" until 1.174.5), rendered inside Setup against the stubbed backend —
// the row's suggestion, Change…, the synced-folder warning, "not a folder",
// the count, the save at the first creation or download and the clone-root
// safeguard; step 8a per row of the outcome table, 8b's account,
// picker, clone run (progress, Cancel, its end: added, empty → first commit
// or keep it empty, the branch question, auth failure), 8c's live preview,
// name wording, folder-has-files and the GitHub copy (off by default, D10);
// every way ending in `workspace_create` and Setup's active workspace; the
// fast checklist's rows; the leave guard for a running clone.
import { afterEach, describe, expect, it, vi } from "vitest";
import { SetupOverlay } from "../components/SetupOverlay";
import { AddProjectSheetHost } from "../components/AddProjectSheet";
import { useToasts } from "../store/toastStore";
import { useAddProject } from "../store/addProjectStore";
import { useUi } from "../store/uiStore";
import { useSetup } from "../store/setupStore";
import { useWorkspaces, type Workspace } from "../store/workspaceStore";
import { useFirstProject } from "../store/firstProjectStore";
import { useWorkMode } from "../store/workModeStore";
import { DEFAULT_SETTINGS, useSettings, type Settings } from "../store/settingsStore";
import { setPlatformForTests } from "../lib/platform";
import type {
  GithubAccount,
  GithubStatus,
  ProjectCloneResult,
  ProjectInspection,
  ProjectNewOutcome,
  ProjectNewPreview,
  ProjectRepoEntry,
  SetupProgressEvent,
  SetupStarted,
} from "../ipc";
import type { SetupStepId } from "../lib/settingsShape";
import { act, nextFrame, renderUi, screen, waitFor, within } from "./render";
import { usePutOnGithub } from "../store/putOnGithubStore";
import { tauri } from "./tauri";

vi.mock("@xterm/xterm", () => {
  const noop = () => ({ dispose() {} });
  class FakeTerm {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    constructor() {
      return new Proxy(this, {
        get(target, prop, receiver) {
          if (prop in target) return Reflect.get(target, prop, receiver);
          return noop;
        },
      });
    }
    write(_data: unknown, done?: () => void) {
      done?.();
    }
  }
  return { Terminal: FakeTerm };
});
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} dispose() {} proposeDimensions() { return undefined; } } }));

afterEach(() => {
  setPlatformForTests(null);
  act(() => useAddProject.setState({ open: false }));
  act(() => useSetup.setState({ open: false, step: null }));
});

// ── The machine ──────────────────────────────────────────────────────────

const acct = (login: string, active = false): GithubAccount => ({
  login,
  active,
  state: "signed-in",
  scopes: "gist, read:org, repo",
});
const status = (accounts: GithubAccount[]): GithubStatus => ({
  ghFound: true,
  accounts,
  helper: "gh",
  githubEmail: null,
  githubNoreply: null,
  sso: null,
});

const insp = (over: Partial<ProjectInspection>): ProjectInspection => ({
  path: "/Users/me/code/lyra",
  name: "lyra",
  outcome: "ready",
  refused: null,
  refusedWords: null,
  git: { kind: "branch", branch: "main", commit: "abc" },
  branches: ["main"],
  suggestedBranch: "main",
  uncommittedChanges: false,
  uncommittedFiles: 0,
  toSave: null,
  largeFiles: [],
  secrets: [],
  ignoreLines: [],
  existingWorkspace: null,
  sharedDefinition: false,
  identityReady: true,
  needsIdentity: false,
  githubOrigin: null,
  ignoreProblem: null,
  foundTruncated: false,
  unnameable: [],
  scanWarning: null,
  partialDownload: false,
  ...over,
});
const summary = { files: 1240, bytes: 18 * 1024 * 1024, complete: true, huge: false, topLevel: [] };

const repo = (over: Partial<ProjectRepoEntry>): ProjectRepoEntry => ({
  nameWithOwner: "me/lyra",
  owner: "me",
  name: "lyra",
  description: null,
  isPrivate: true,
  isEmpty: false,
  updatedAt: null,
  diskUsageKb: 18432,
  defaultBranch: "main",
  group: "yours",
  groupOwner: "me",
  inPly: null,
  ...over,
});

const ws = (id: string, name: string, cwd: string): Workspace => ({
  id,
  name,
  cwd,
  createdAt: 1,
  lastOpenedAt: 1,
  openFiles: [],
  activeFile: null,
});

interface Opts {
  step?: SetupStepId;
  settings?: Partial<Settings>;
  level?: "guided" | "fast";
  github?: GithubStatus;
  gitIdentity?: boolean;
  workspaces?: Workspace[];
  /** `project_inspect`, by path. */
  inspect?: Record<string, ProjectInspection>;
  /** 1.171.0 D3: `project_inspect_work`, by path. */
  inspectWork?: Record<string, ProjectInspection>;
  /** 1.171.0 D3: `project_save_work` refuses with these words. */
  saveWorkFails?: string;
  repos?: ProjectRepoEntry[];
  preview?: (name: string) => ProjectNewPreview;
  created?: ProjectNewOutcome;
  look?: { projects: number; path?: string; exists?: boolean; notAFolder?: boolean };
  teamStatus?: unknown;
  /** QoL 7.2: the Add a project sheet instead of Setup. */
  sheet?: boolean;
}

async function openStep(o: Opts = {}) {
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    ...o.settings,
    onboarding: { ...DEFAULT_SETTINGS.onboarding, level: o.level ?? "guided", ...o.settings?.onboarding },
  };
  const list: Workspace[] = [...(o.workspaces ?? [])];
  let active: string | null = list[0]?.id ?? null;
  let n = 0;
  act(() => {
    useSettings.setState({ settings, loaded: true });
    useWorkspaces.setState({ workspaces: [...list], activeId: active });
  });
  const inspections = o.inspect ?? {};
  const r = renderUi(o.sheet ? <AddProjectSheetHost /> : <SetupOverlay />, {
    fixtures: {
      settings_set: ({ settings: next }: Record<string, unknown>) => next,
      dependency_doctor: {
        tools: [
          { id: "git", found: true, versionOk: true },
          { id: "claude", found: true, versionOk: true },
          { id: "gh", found: true, versionOk: true },
        ],
        allRequiredOk: true,
        aiReady: true,
        gitWorks: true,
        gitIdentity: o.gitIdentity === false ? { name: null, email: null } : { name: "Me", email: "me@example.com" },
        whisperModel: { model: "small", present: false, path: null, detail: "Not downloaded." },
      },
      team_work_mode: { mode: "solo", chosen: true },
      team_status: o.teamStatus ?? { teamRepo: null, teamName: null, hasClone: false, error: null, workspaces: [] },
      project_config_list: [],
      // OB-13: Continue after a project lands on step 9, which reads it.
      project_detect_for_setup: {
        state: "proposal",
        config: { schemaVersion: 2, targetBranch: "main", versionFiles: [], installScript: null, verifyPipeline: null, createdAt: 0, updatedAt: 0 },
        branches: ["main"],
        suggestedBranch: null,
        branchFrom: "head",
        head: "branch",
        headBranch: "main",
        detectedVerify: null,
        version: null,
        readOnly: false,
      },
      // Try it: step 9's line about how the app starts.
      project_try_command_get: {
        command: null,
        approved: true,
        shared: false,
        readOnly: false,
        hasConfig: false,
        detection: { kind: "none" },
      },
      build_cache_status: null,
      setup_check: { signedIn: true, method: "claude.ai", plan: "max", words: null },
      setup_github_status: o.github ?? status([]),
      setup_identity_prefill: { name: "", nameSource: "none", email: "", emailSource: "none", githubNoreply: null, githubLogin: null },
      projects_folder_look: {
        path: o.look?.path ?? "/Users/me/Projects",
        exists: o.look?.exists ?? true,
        notAFolder: o.look?.notAFolder ?? false,
        projects: o.look?.projects ?? 0,
      },
      projects_folder_create: ({ folder }: Record<string, unknown>) => String(folder).replace("~", "/Users/me"),
      project_inspect: ({ path }: Record<string, unknown>) => {
        const found = inspections[String(path)];
        if (found) return found;
        // A registered workspace (the probe): a repo on main.
        return insp({ path: String(path), outcome: "already-in-ply" });
      },
      // Rust's plan: the defaults, then each file left out as `/path`.
      project_ignore_plan: ({ leaveOut }: Record<string, unknown>) => [
        "node_modules/",
        ...(leaveOut as string[]).map((p) => `/${p}`),
      ],
      project_init: ({ path }: Record<string, unknown>) => ({ path, branch: "main", commit: "c1", initialised: true, ignoreAdded: [] }),
      project_inspect_work: ({ path }: Record<string, unknown>) => o.inspectWork?.[String(path)] ?? inspections[String(path)],
      project_save_work: ({ path }: Record<string, unknown>) =>
        o.saveWorkFails
          ? Promise.reject(o.saveWorkFails)
          : { path, branch: "my-work", commit: "c2", ignoreAdded: [] },
      // Rust's save-work plan: one `/path` per new file left out, no defaults.
      project_work_ignore_plan: ({ leaveOut }: Record<string, unknown>) => (leaveOut as string[]).map((p) => `/${p}`),
      project_repo_list: ({ account }: Record<string, unknown>) => ({
        login: account ?? "me",
        repos: o.repos ?? [],
        truncated: false,
        errors: [],
      }),
      // 1.175.0 F2: in the row's folder when one is passed (`parent`).
      project_new_preview: ({ name, parent }: Record<string, unknown>) =>
        o.preview
          ? o.preview(String(name))
          : {
              name: String(name),
              slug: String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-"),
              path: `${(parent as string | null) ?? "/Users/me/Projects"}/${String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
              displayPath: `${((parent as string | null) ?? "/Users/me/Projects").replace(/^\/Users\/me/, "~")}/${String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
              folder: "missing",
              insideRepo: null,
              problem: null,
              placeRefused: false,
            },
      project_new: ({ request }: Record<string, unknown>) => {
        const req = request as { name: string; githubCopy: { login: string } | null };
        return (
          o.created ?? {
            kind: "created",
            path: "/Users/me/Projects/my-app",
            name: req.name,
            slug: "my-app",
            branch: "main",
            commit: "c1",
            github: req.githubCopy ? { state: "created", repo: `${req.githubCopy.login}/my-app`, words: null } : null,
          }
        );
      },
      project_first_commit_push: ({ path }: Record<string, unknown>) => ({ path, branch: "main", commit: "c1", pushed: true, words: null }),
      workspace_create: ({ cwd, name }: Record<string, unknown>) => {
        const made = ws(`new-${++n}`, String(name), String(cwd));
        list.push(made);
        return made;
      },
      workspace_list: () => ({ workspaces: [...list], activeWorkspaceId: active }),
      workspace_cwd_exists: true,
      workspace_set_active: ({ id }: Record<string, unknown>) => {
        active = String(id);
        return null;
      },
      workspace_set_github_account: null,
      setup_stop: true,
      setup_active: null,
      setup_open_github_sso: null,
      pty_resize: null,
      "plugin:path|resolve_directory": "/Users/me",
    },
  });
  if (o.sheet) {
    act(() => useAddProject.getState().openAddProject());
    await nextFrame();
    return r;
  }
  act(() => useSetup.getState().openSetup("rerun", o.step ?? "project"));
  await nextFrame();
  const titles: Partial<Record<SetupStepId, string>> = {
    project: "Your first project",
  };
  const want = titles[o.step ?? "project"];
  if (want) await waitFor(() => expect(stepTitle()).toBe(want));
  return r;
}

const stepTitle = () => document.querySelector(".ux-setup-steptitle")?.textContent;
const footer = () => document.querySelector(".ux-setup-foot") as HTMLElement;
/** The footer's primary is handed up by the step after it renders: wait. */
const footerButton = (name: string) => waitFor(() => within(footer()).getByRole("button", { name }));
const content = () => document.querySelector(".ux-setup-content") as HTMLElement;
const stepList = () => screen.getByRole("navigation", { name: "Setup steps" });
const last = <T,>(list: T[]): T | undefined => list[list.length - 1];
/** A row of the step by its label (the Projects folder row, F2). */
const rowOf = (label: string) =>
  within(content()).getByText(label, { selector: ".ux-row-label, .ux-row-label *" }).closest(".ux-row") as HTMLElement;
const picked = (path: string | null) => tauri().fixture("plugin:dialog|open", path);
const emit = (event: Partial<SetupProgressEvent> & { runId: string }) =>
  act(() =>
    tauri().emit("setup://progress", {
      actionId: "project.clone",
      ptyId: "pty-c",
      phase: "running",
      outcome: null,
      exitCode: null,
      reprobed: false,
      tail: [],
      ...event,
    }),
  );
const CLONE_RUN: SetupStarted = {
  runId: "run-c",
  actionId: "project.clone",
  ptyId: "pty-c",
  display: "gh repo clone me/lyra /Users/me/Projects/lyra -- --progress",
  watch: { kind: "cloned" },
};
const cloneDone = (over: Partial<ProjectCloneResult>): ProjectCloneResult => ({
  path: "/Users/me/Projects/lyra",
  repo: "me/lyra",
  cloned: true,
  empty: false,
  branch: "main",
  remoteBranches: [],
  failure: null,
  removedPartial: false,
  ...over,
});

async function chooseWay(user: ReturnType<typeof renderUi>["user"], label: RegExp) {
  await user.click(within(content()).getByRole("radio", { name: label }));
}

// ── The Projects folder row (1.175.0 F2, mockup §2b) ─────────────────────
// Until 1.174.5 the step "Where your projects live" (step 7). Now a row in
// "Your first project", in the two ways that make a folder, saved at the
// first creation or download and not before.

describe("F2: the Projects folder row", () => {
  const folderWrites = () =>
    tauri()
      .callsOf("settings_set")
      .map((c) => (c.args.settings as Settings).projects?.folder ?? null)
      .filter(Boolean);
  const createMyApp = async (user: ReturnType<typeof renderUi>["user"]) => {
    await user.type(within(content()).getByRole("textbox", { name: "Name" }), "My app");
    await waitFor(() => expect(content().textContent).toMatch(/It goes in .*my-app\./));
    await waitFor(() => expect((within(footer()).getByRole("button", { name: "Create project" }) as HTMLButtonElement).disabled).toBe(false));
    await user.click(within(footer()).getByRole("button", { name: "Create project" }));
    await user.click(within(await screen.findByRole("dialog", { name: "Create “My app”?" })).getByRole("button", { name: "Create project" }));
  };

  it("there is no step for it; A new, empty project shows the row with ~/Projects, nothing to press", async () => {
    const { user } = await openStep();
    expect(within(stepList()).queryByText("Where your projects live")).toBeNull();
    await chooseWay(user, /A new, empty project/);
    const row = await waitFor(() => rowOf("Projects folder"));
    expect(row.textContent).toContain("~/Projects");
    expect(row.textContent).toContain("New projects and the ones you get from GitHub go here.");
    expect(within(row).getByRole("button", { name: "Change…" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Use this folder" })).toBeNull();
    // Shown is not saved.
    await nextFrame();
    expect(folderWrites()).toEqual([]);
    expect(tauri().callsOf("projects_folder_create")).toHaveLength(0);
  });

  // F2 round 2 (review): the setting is saved once the project was made,
  // never before the attempt.
  it("the first creation saves it in tilde form — after the project was made", async () => {
    const { user } = await openStep();
    await chooseWay(user, /A new, empty project/);
    await createMyApp(user);
    await waitFor(() => expect(useSettings.getState().settings.projects?.folder).toBe("~/Projects"));
    expect(tauri().callsOf("project_new")[0].args).toEqual({ request: { name: "My app", parent: null, githubCopy: null } });
    expect(tauri().callsOf("projects_folder_create")[0].args).toEqual({ folder: "~/Projects" });
    const order = tauri().calls.map((c) => c.cmd);
    const saved = tauri().calls.findIndex((c) => c.cmd === "settings_set" && (c.args.settings as Settings).projects?.folder === "~/Projects");
    expect(order.indexOf("project_new")).toBeLessThan(saved);
  });

  it("a creation that doesn't go through leaves the setting as it was", async () => {
    const { user } = await openStep({ created: { kind: "refused", words: "That name is taken by the projects folder." } as never });
    await chooseWay(user, /A new, empty project/);
    await createMyApp(user);
    await waitFor(() => expect(content().textContent).toContain("That name is taken by the projects folder."));
    expect(folderWrites()).toEqual([]);
    expect(useSettings.getState().settings.projects?.folder ?? null).toBeNull();
  });

  it("~/code is never suggested; Change… moves “It goes in …” and is kept in tilde form at Create", async () => {
    const { user } = await openStep();
    await chooseWay(user, /A new, empty project/);
    expect(content().textContent).not.toContain("~/code");
    picked("/Users/me/dev/work");
    await user.click(within(rowOf("Projects folder")).getByRole("button", { name: "Change…" }));
    await waitFor(() => expect(rowOf("Projects folder").textContent).toContain("~/dev/work"));
    expect(last(tauri().callsOf("projects_folder_look"))?.args).toEqual({ folder: "~/dev/work" });
    await user.type(within(content()).getByRole("textbox", { name: "Name" }), "My app");
    await waitFor(() => expect(content().textContent).toContain("It goes in ~/dev/work/my-app."));
    expect(last(tauri().callsOf("project_new_preview"))?.args).toEqual({ name: "My app", parent: "/Users/me/dev/work" });
    expect(folderWrites()).toEqual([]);
    await user.click(await footerButton("Create project"));
    await user.click(within(screen.getByRole("dialog", { name: "Create “My app”?" })).getByRole("button", { name: "Create project" }));
    await waitFor(() => expect(useSettings.getState().settings.projects?.folder).toBe("~/dev/work"));
    // Made for the attempt, and the project made in it; then saved.
    expect(tauri().callsOf("projects_folder_create")[0].args).toEqual({ folder: "~/dev/work" });
    expect(tauri().callsOf("project_new")[0].args).toEqual({ request: { name: "My app", parent: "/Users/me/dev/work", githubCopy: null } });
  });

  it("Windows: %USERPROFILE%\\Projects, stored with forward slashes", async () => {
    setPlatformForTests("windows");
    const { user } = await openStep();
    await chooseWay(user, /A new, empty project/);
    expect(rowOf("Projects folder").textContent).toContain("%USERPROFILE%\\Projects");
    tauri().fixture("plugin:path|resolve_directory", "C:\\Users\\me");
    picked("C:\\Users\\me\\Work\\Projects");
    await user.click(within(rowOf("Projects folder")).getByRole("button", { name: "Change…" }));
    await waitFor(() => expect(rowOf("Projects folder").textContent).toContain("%USERPROFILE%\\Work\\Projects"));
    await createMyApp(user);
    await waitFor(() => expect(useSettings.getState().settings.projects?.folder).toBe("~/Work/Projects"));
  });

  it("an iCloud Drive or OneDrive folder is warned about, not refused", async () => {
    const { user } = await openStep();
    await chooseWay(user, /A new, empty project/);
    picked("/Users/me/Library/Mobile Documents/com~apple~CloudDocs/Projects");
    await user.click(within(rowOf("Projects folder")).getByRole("button", { name: "Change…" }));
    await waitFor(() =>
      expect(content().textContent).toContain("Folders synced by iCloud Drive can corrupt Git projects. Choose a folder outside it."),
    );
    await user.type(within(content()).getByRole("textbox", { name: "Name" }), "My app");
    await waitFor(() => expect(((within(footer()).getByRole("button", { name: "Create project" })) as HTMLButtonElement).disabled).toBe(false));
  });

  it("OneDrive on Windows is warned about the same way", async () => {
    setPlatformForTests("windows");
    const { user } = await openStep();
    await chooseWay(user, /A new, empty project/);
    tauri().fixture("plugin:path|resolve_directory", "C:\\Users\\me");
    picked("C:\\Users\\me\\OneDrive\\Projects");
    await user.click(within(rowOf("Projects folder")).getByRole("button", { name: "Change…" }));
    await waitFor(() =>
      expect(content().textContent).toContain("Folders synced by OneDrive can corrupt Git projects. Choose a folder outside it."),
    );
  });

  it("a file with that name: the row says so and the way's primary waits", async () => {
    const { user } = await openStep({ look: { projects: 0, notAFolder: true } });
    await chooseWay(user, /A new, empty project/);
    await waitFor(() =>
      expect(rowOf("Projects folder").textContent).toContain("There's a file with that name, not a folder. Choose another folder."),
    );
    await user.type(within(content()).getByRole("textbox", { name: "Name" }), "My app");
    await waitFor(() => expect(content().textContent).toContain("It goes in ~/Projects/my-app."));
    expect(((within(footer()).getByRole("button", { name: "Create project" })) as HTMLButtonElement).disabled).toBe(true);
  });

  it("after the first time: the count of projects already there", async () => {
    const { user } = await openStep({ settings: { projects: { folder: "~/Projects" } }, look: { projects: 6 } });
    await chooseWay(user, /A new, empty project/);
    await waitFor(() => expect(rowOf("Projects folder").textContent).toContain("Plyloft found 6 projects here."));
    expect(rowOf("Projects folder").textContent).not.toContain("New projects and the ones you get from GitHub go here.");
  });

  it("the safeguard: team workspaces already cloned under ~/code keep their clone root, written first", async () => {
    act(() => useWorkMode.setState({ mode: "team" }));
    const { user } = await openStep({
      teamStatus: {
        teamRepo: "mb/team",
        teamName: "MB",
        hasClone: true,
        error: null,
        workspaces: [{ cloned: true, registered: true }],
      },
    });
    tauri().allowUnhandled();
    await chooseWay(user, /A new, empty project/);
    await createMyApp(user);
    await waitFor(() => expect(useSettings.getState().settings.projects?.folder).toBe("~/Projects"));
    const writes = tauri()
      .callsOf("settings_set")
      .map((c) => c.args.settings as Settings);
    const root = writes.findIndex((w) => w.team.cloneRoot === "~/code");
    const folder = writes.findIndex((w) => w.projects.folder === "~/Projects");
    expect(root).toBeGreaterThanOrEqual(0);
    expect(root).toBeLessThan(folder);
  });

  it("From GitHub: the row above the list; the sheet names the folder; the first download saves it", async () => {
    const { user } = await openStep({ github: status([acct("me", true)]), repos: [repo({})] });
    tauri().fixture("project_clone", { kind: "started", run: CLONE_RUN, path: "/Users/me/dev/work/lyra" });
    await chooseWay(user, /From GitHub/);
    await waitFor(() => expect(rowOf("Projects folder").textContent).toContain("~/Projects"));
    picked("/Users/me/dev/work");
    await user.click(within(rowOf("Projects folder")).getByRole("button", { name: "Change…" }));
    await waitFor(() => expect(rowOf("Projects folder").textContent).toContain("~/dev/work"));
    await user.click(await within(content()).findByRole("button", { name: "Get" }));
    const sheet = screen.getByRole("dialog", { name: "Get “lyra”?" });
    expect(sheet.textContent).toContain("Plyloft will download it into ~/dev/work/lyra.");
    expect(folderWrites()).toEqual([]);
    await user.click(within(sheet).getByRole("button", { name: "Get it" }));
    await waitFor(() => expect(tauri().callsOf("project_clone")).toHaveLength(1));
    // F2 round 2: the clone goes into the folder made for it; the setting
    // waits for the clone to land.
    expect(tauri().callsOf("project_clone")[0].args).toMatchObject({ repo: "me/lyra", destParent: "/Users/me/dev/work" });
    const order = tauri().calls.map((c) => c.cmd);
    expect(order.indexOf("projects_folder_create")).toBeLessThan(order.indexOf("project_clone"));
    expect(folderWrites()).toEqual([]);
    emit({ runId: "run-c", phase: "done", outcome: "succeeded", exitCode: 0, clone: cloneDone({ path: "/Users/me/dev/work/lyra" }) });
    await waitFor(() => expect(useSettings.getState().settings.projects?.folder).toBe("~/dev/work"));
  });

  it("From GitHub: a download that fails or is stopped saves nothing", async () => {
    const { user } = await openStep({ github: status([acct("me", true)]), repos: [repo({})] });
    tauri().fixture("project_clone", { kind: "started", run: CLONE_RUN, path: "/Users/me/Projects/lyra" });
    await chooseWay(user, /From GitHub/);
    await user.click(await within(content()).findByRole("button", { name: "Get" }));
    await user.click(within(screen.getByRole("dialog", { name: "Get “lyra”?" })).getByRole("button", { name: "Get it" }));
    await waitFor(() => expect(tauri().callsOf("project_clone")).toHaveLength(1));
    expect(tauri().callsOf("project_clone")[0].args).toMatchObject({ destParent: null });
    emit({
      runId: "run-c",
      phase: "done",
      outcome: "cancelled",
      exitCode: null,
      clone: cloneDone({ cloned: false, removedPartial: true }),
    });
    await nextFrame();
    await nextFrame();
    expect(folderWrites()).toEqual([]);
    expect(useSettings.getState().settings.projects?.folder ?? null).toBeNull();
  });

  it("A folder on this Mac never shows the row", async () => {
    const { user } = await openStep();
    await chooseWay(user, /A folder on this Mac/);
    await nextFrame();
    expect(content().textContent).not.toContain("Projects folder");
  });
});

// ── Step 8: the ways ─────────────────────────────────────────────────────

describe("Setup step 8, the three ways", () => {
  it("From GitHub waits for GitHub; existing users read how many projects they have", async () => {
    await openStep({ workspaces: [ws("w1", "atlas", "/Users/me/code/atlas"), ws("w2", "vega", "/v")] });
    expect(content().textContent).toContain("You already have 2 projects in Plyloft.");
    const github = within(content()).getByRole("radio", { name: /From GitHub/ }) as HTMLInputElement;
    expect(github.disabled).toBe(true);
    expect(content().textContent).toContain("Connect GitHub first.");
    expect(within(content()).getByRole("radio", { name: /A folder on this Mac/ })).toBeTruthy();
    expect(within(content()).getByRole("radio", { name: /A new, empty project/ })).toBeTruthy();
    // Done already (a repo with a commit): Continue.
    await waitFor(() =>
      expect((within(footer()).getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(false),
    );
  });
});

// ── 8a ───────────────────────────────────────────────────────────────────

describe("Setup step 8a, a folder on this Mac", () => {
  it("1.176.3: says what to choose, and the panel opens on the Projects folder Setup knows (home when it isn't there)", async () => {
    const { user } = await openStep({});
    // 1.176.3 (walk): on entry, before anything is chosen, the step already says what to choose.
    expect(content().textContent).toContain("Choose the folder that holds your project");
    await chooseWay(user, /A folder on this Mac/);
    expect(content().textContent).toContain(
      "Choose the folder that holds your project, the one with your files in it. Plyloft never changes it while you build: each card works in its own copy.",
    );
    picked(null);
    await user.click(await footerButton("Choose a folder"));
    await waitFor(() => expect(tauri().callsOf("plugin:dialog|open")).toHaveLength(1));
    expect(tauri().callsOf("plugin:dialog|open")[0].args).toMatchObject({
      options: { directory: true, defaultPath: "/Users/me/Projects" },
    });
    tauri().fixture("projects_folder_look", { path: "/Users/me/Projects", exists: false, notAFolder: false, projects: 0 });
    await user.click(await footerButton("Choose a folder"));
    await waitFor(() => expect(tauri().callsOf("plugin:dialog|open")).toHaveLength(2));
    expect(tauri().callsOf("plugin:dialog|open")[1].args).toMatchObject({ options: { defaultPath: "/Users/me" } });
  });

  it("a Git project on a branch → Add to Plyloft → workspace_create, Setup's active workspace, step done", async () => {
    const { user } = await openStep({ inspect: { "/Users/me/code/lyra": insp({}) } });
    await chooseWay(user, /A folder on this Mac/);
    picked("/Users/me/code/lyra");
    await user.click(await footerButton("Choose a folder"));
    await waitFor(() => expect(content().textContent).toContain("“lyra” is a Git project on branch main."));
    await user.click(await footerButton("Add to Plyloft"));
    await waitFor(() => expect(content().textContent).toContain("“lyra” is in Plyloft."));
    expect(tauri().callsOf("workspace_create")[0].args).toEqual({ cwd: "/Users/me/code/lyra", name: "lyra" });
    expect(useWorkspaces.getState().activeId).toBe("new-1");
    expect(tauri().callsOf("workspace_set_github_account")).toHaveLength(0);
    await waitFor(() =>
      expect(within(stepList()).getByRole("button", { name: /Your first project/ }).textContent).toContain("Done"),
    );
    await user.click(await footerButton("Continue"));
    await waitFor(() => expect(stepTitle()).not.toBe("Your first project"));
  });

  it("1.175.0 F3: no origin, GitHub connected — Also keep a private copy on GitHub, off; ticked, Add asks first", async () => {
    const { user } = await openStep({
      github: status([acct("octocat", true)]),
      inspect: { "/Users/me/code/lyra": insp({ hasOrigin: false, githubName: "lyra" }) },
    });
    await chooseWay(user, /A folder on this Mac/);
    picked("/Users/me/code/lyra");
    await user.click(await footerButton("Choose a folder"));
    const tick = await within(content()).findByRole("checkbox", { name: /Also keep a private copy on GitHub/ });
    expect((tick as HTMLInputElement).checked).toBe(false);
    expect(content().textContent).toContain(
      "This project is only on this Mac. Creates the private repository octocat/lyra and sends it main, so cards ship as pull requests.",
    );
    await user.click(tick);
    await user.click(await footerButton("Add to Plyloft"));
    const sheet = await screen.findByRole("dialog", { name: "Add “lyra” and put it on GitHub?" });
    await waitFor(() => expect(document.activeElement).toBe(within(sheet).getByRole("button", { name: "Cancel" })));
    expect(tauri().callsOf("workspace_create")).toHaveLength(0);
    await user.click(within(sheet).getByRole("button", { name: "Add and put it on GitHub" }));
    await waitFor(() => expect(tauri().callsOf("workspace_create")).toHaveLength(1));
    // The copy runs in its own sheet (Stop, outcome), started by this press.
    await waitFor(() =>
      expect(usePutOnGithub.getState().asked).toEqual({
        workspaceId: "new-1",
        project: "lyra",
        start: { login: "octocat", name: "lyra" },
      }),
    );
    act(() => usePutOnGithub.setState({ asked: null }));
  });

  it("1.175.0 F3: unticked, Add adds it as before — nothing asked of GitHub", async () => {
    const { user } = await openStep({
      github: status([acct("octocat", true)]),
      inspect: { "/Users/me/code/lyra": insp({ hasOrigin: false, githubName: "lyra" }) },
    });
    await chooseWay(user, /A folder on this Mac/);
    picked("/Users/me/code/lyra");
    await user.click(await footerButton("Choose a folder"));
    await within(content()).findByRole("checkbox", { name: /Also keep a private copy on GitHub/ });
    await user.click(await footerButton("Add to Plyloft"));
    await waitFor(() => expect(tauri().callsOf("workspace_create")).toHaveLength(1));
    expect(usePutOnGithub.getState().asked).toBeNull();
  });

  it("1.175.0 F3: GitHub not connected — no tick, says where to put it on GitHub later", async () => {
    const { user } = await openStep({
      inspect: {
        "/Users/me/code/lyra": insp({ hasOrigin: false, githubName: "lyra" }),
      },
    });
    await chooseWay(user, /A folder on this Mac/);
    picked("/Users/me/code/lyra");
    await user.click(await footerButton("Choose a folder"));
    await waitFor(() => expect(content().textContent).toContain("connect GitHub in Settings › Setup and account › Setup"));
    expect(within(content()).queryByRole("checkbox", { name: /private copy on GitHub/ })).toBeNull();
  });

  it("already in Plyloft → Open it makes it Setup's active workspace, nothing registered", async () => {
    const existing = ws("w9", "lyra", "/Users/me/code/lyra");
    const { user } = await openStep({
      workspaces: [ws("w1", "atlas", "/a"), existing],
      inspect: {
        "/Users/me/code/lyra": insp({ outcome: "already-in-ply", existingWorkspace: { id: "w9", name: "lyra", cwd: "/Users/me/code/lyra" } }),
      },
    });
    await chooseWay(user, /A folder on this Mac/);
    picked("/Users/me/code/lyra");
    await user.click(await footerButton("Choose a folder"));
    await waitFor(() => expect(content().textContent).toContain("“lyra” is already in Plyloft."));
    await user.click(await footerButton("Open it"));
    await waitFor(() => expect(useWorkspaces.getState().activeId).toBe("w9"));
    expect(tauri().callsOf("workspace_create")).toHaveLength(0);
  });

  it("not a repo → Start Git and add: the sheet lists what is saved and left out, names every command", async () => {
    const folder = insp({
      outcome: "not-a-repo",
      git: { kind: "not-repo" },
      branches: [],
      toSave: summary,
      ignoreLines: ["node_modules/", ".env"],
      largeFiles: [{ path: "media/intro.mov", bytes: 80 * 1024 * 1024 }],
      secrets: [{ path: "deploy.pem", bytes: 20 }],
    });
    const { user } = await openStep({ inspect: { "/Users/me/code/lyra": folder } });
    await chooseWay(user, /A folder on this Mac/);
    picked("/Users/me/code/lyra");
    await user.click(await footerButton("Choose a folder"));
    await waitFor(() => expect(content().textContent).toContain("Make “lyra” a Git project?"));
    expect(content().textContent).toContain(
      "Plyloft will start Git here and save everything in the folder as the first version. Nothing is uploaded.",
    );
    await user.click(await footerButton("Start Git and add"));
    const sheet = screen.getByRole("dialog", { name: "Make “lyra” a Git project?" });
    expect(sheet.textContent).toContain(
      "1 240 files, 18 MB. Plyloft adds a .gitignore that leaves out node_modules, build output and .env files.",
    );
    expect(sheet.textContent).toContain("These files are over 50 MB. GitHub refuses files over 100 MB, so Plyloft leaves them out:");
    expect(sheet.textContent).toContain("These look like passwords or keys. Plyloft leaves them out of Git:");
    const pem = within(sheet).getByRole("checkbox", { name: /deploy\.pem/ }) as HTMLInputElement;
    expect(pem.checked).toBe(true);
    expect(sheet.textContent).toContain("git init -b main");
    expect(sheet.textContent).toContain('git commit -m "chore: first commit"');
    await waitFor(() => expect(sheet.textContent).toContain("/media/intro.mov"));
    expect(tauri().callsOf("project_ignore_plan")[0].args).toEqual({
      path: "/Users/me/code/lyra",
      secrets: ["deploy.pem"],
      leaveOut: ["media/intro.mov", "deploy.pem"],
    });
    expect(sheet.textContent).toContain("/deploy.pem");
    // Unticking a secret: allowed, with a warning.
    await user.click(pem);
    // The Details follow the ticks, as Rust plans them.
    await waitFor(() => expect(sheet.textContent).not.toContain("/deploy.pem"));
    expect(sheet.textContent).toContain("“deploy.pem” will be saved in Git. Anyone who gets a copy of this project can read it.");
    await user.click(within(sheet).getByRole("button", { name: "Start Git and add" }));
    await waitFor(() => expect(tauri().callsOf("project_init")).toHaveLength(1));
    expect(tauri().callsOf("project_init")[0].args).toEqual({
      path: "/Users/me/code/lyra",
      choices: { leaveOut: ["media/intro.mov"], acceptIncomplete: false },
    });
    await waitFor(() => expect(tauri().callsOf("workspace_create")[0].args).toEqual({ cwd: "/Users/me/code/lyra", name: "lyra" }));
  });

  it("huge and counted only in part: the warning, what will be saved, and Save it anyway before it can go", async () => {
    const warn = "Plyloft stopped counting at 50 000 files or 5 seconds, so files past that weren't checked for keys or size.";
    const folder = insp({
      outcome: "no-commits",
      git: { kind: "unborn", branch: "main" },
      branches: [],
      toSave: { files: 50000, bytes: 3 * 1024 ** 3, complete: false, huge: true, topLevel: [{ name: "assets", isDir: true, files: 48000, bytes: 3 * 1024 ** 3 }] },
      scanWarning: warn,
    });
    const { user } = await openStep({ inspect: { "/Users/me/code/lyra": folder } });
    await chooseWay(user, /A folder on this Mac/);
    picked("/Users/me/code/lyra");
    await user.click(await footerButton("Choose a folder"));
    await waitFor(() => expect(content().textContent).toContain("“lyra” has no saved version yet."));
    await user.click(await footerButton("Save and add"));
    const sheet = screen.getByRole("dialog", { name: "Save “lyra”'s first version?" });
    expect(sheet.textContent).toContain("That's a lot to save in one go. Check the list of what's left out before continuing.");
    expect(sheet.textContent).toContain(warn);
    expect(sheet.textContent).not.toContain("git init -b main");
    await user.click(within(sheet).getByText("Show what will be saved"));
    expect(sheet.textContent).toContain("assets/  48 000 files, 3.0 GB");
    const go = within(sheet).getByRole("button", { name: "Save and add" }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    await user.click(within(sheet).getByRole("checkbox", { name: "Save it anyway" }));
    expect(go.disabled).toBe(false);
    await user.click(go);
    await waitFor(() => expect(tauri().callsOf("project_init")[0]?.args).toMatchObject({ choices: { acceptIncomplete: true } }));
  });

  it("detached HEAD → which branch (main preselected), kept for step 9; the folder isn't switched", async () => {
    const folder = insp({
      outcome: "choose-branch",
      git: { kind: "detached", commit: "abc" },
      branches: ["feature", "main", "master"],
      suggestedBranch: "main",
    });
    const { user } = await openStep({ inspect: { "/Users/me/code/lyra": folder } });
    await chooseWay(user, /A folder on this Mac/);
    picked("/Users/me/code/lyra");
    await user.click(await footerButton("Choose a folder"));
    await waitFor(() => expect(content().textContent).toContain("“lyra” isn't on a branch right now."));
    expect(content().textContent).toContain("Cards start from a branch and are merged back into it. Which one?");
    const select = within(content()).getByRole("combobox", { name: "Cards start from" }) as HTMLSelectElement;
    expect(select.value).toBe("main");
    await user.selectOptions(select, "feature");
    await user.click(await footerButton("Add to Plyloft"));
    await waitFor(() => expect(tauri().callsOf("workspace_create")).toHaveLength(1));
    expect(useFirstProject.getState().targetBranch["new-1"]).toBe("feature");
    expect(tauri().callsOf("project_init")).toHaveLength(0);
  });

  it("inside another repo → Use “monorepo” instead looks at that one", async () => {
    const { user } = await openStep({
      inspect: {
        "/Users/me/code/monorepo/app": insp({
          path: "/Users/me/code/monorepo/app",
          name: "app",
          outcome: "inside-another-repo",
          git: { kind: "inside-another", topLevel: "/Users/me/code/monorepo", name: "monorepo", inPly: null },
        }),
        "/Users/me/code/monorepo": insp({ path: "/Users/me/code/monorepo", name: "monorepo" }),
      },
    });
    await chooseWay(user, /A folder on this Mac/);
    picked("/Users/me/code/monorepo/app");
    await user.click(await footerButton("Choose a folder"));
    await waitFor(() => expect(content().textContent).toContain("This folder is inside another Git project, “monorepo”."));
    expect(within(content()).getByRole("button", { name: "Choose another folder" })).toBeTruthy();
    await user.click(await footerButton("Use “monorepo” instead"));
    await waitFor(() => expect(content().textContent).toContain("“monorepo” is a Git project on branch main."));
  });

  it.each([
    ["refused (the home folder)", insp({ outcome: "refused", refused: "home", refusedWords: "Choose a project folder, not your whole home folder." }), "Choose a project folder, not your whole home folder."],
    ["a .gitignore it can't change", insp({ outcome: "not-a-repo", git: { kind: "not-repo" }, toSave: summary, ignoreProblem: ".gitignore is a link, so Plyloft won't change it." }), ".gitignore is a link, so Plyloft won't change it."],
    ["names a .gitignore can't hold", insp({ outcome: "not-a-repo", git: { kind: "not-repo" }, toSave: summary, unnameable: ["a\nb.key"], scanWarning: "Some files that look like keys … Rename them, then look again." }), "Some files that look like keys … Rename them, then look again."],
    ["more found than listed", insp({ outcome: "not-a-repo", git: { kind: "not-repo" }, toSave: summary, foundTruncated: true, scanWarning: "There are more than 200 large files or likely keys here." }), "There are more than 200 large files or likely keys here."],
    ["a partial download", insp({ outcome: "no-commits", git: { kind: "unborn", branch: "main" }, toSave: summary, partialDownload: true }), "This folder holds a download from GitHub that didn't finish."],
  ])("%s: said in words, and the only way on is another folder", async (_name, folder, words) => {
    const { user } = await openStep({ inspect: { "/Users/me/x": folder } });
    await chooseWay(user, /A folder on this Mac/);
    picked("/Users/me/x");
    await user.click(await footerButton("Choose a folder"));
    await waitFor(() => expect(content().textContent).toContain(words));
    expect(await footerButton("Choose another folder")).toBeTruthy();
    expect(tauri().callsOf("project_init")).toHaveLength(0);
  });

  it("no git identity: the first commit waits, with Go to Git and your name", async () => {
    const folder = insp({ outcome: "not-a-repo", git: { kind: "not-repo" }, toSave: summary, needsIdentity: true, identityReady: false });
    const { user } = await openStep({ inspect: { "/Users/me/code/lyra": folder } });
    await chooseWay(user, /A folder on this Mac/);
    picked("/Users/me/code/lyra");
    await user.click(await footerButton("Choose a folder"));
    await waitFor(() => expect(content().textContent).toContain("Git needs your name and email"));
    expect(((await footerButton("Start Git and add")) as HTMLButtonElement).disabled).toBe(true);
    await user.click(within(content()).getByRole("button", { name: "Go to Git and your name" }));
    await waitFor(() => expect(stepTitle()).toBe("Git and your name"));
  });

  // 1.171.0 D3 (FR-5): changes not saved in Git are asked about first.
  it("changes not saved in Git: Leave my changes in the folder (the default) adds it as it is and says so; the account is asked", async () => {
    const folder = insp({ uncommittedChanges: true, uncommittedFiles: 12, githubOrigin: "work/lyra", sharedDefinition: true });
    const { user } = await openStep({
      github: status([acct("me", true), acct("work")]),
      inspect: { "/Users/me/code/lyra": folder },
    });
    await chooseWay(user, /A folder on this Mac/);
    picked("/Users/me/code/lyra");
    await user.click(await footerButton("Choose a folder"));
    await waitFor(() =>
      expect(content().textContent).toContain(
        "This folder has changes that aren't saved in Git yet (12 files or folders). Cards only see what's saved.",
      ),
    );
    expect(content().textContent).toContain("This project brings its own Plyloft settings.");
    // 1.174.0 C16 (NIW-6): leaving them is first and chosen, since it
    // writes nothing; saving names the branch and is the second way.
    const leave = within(content()).getByRole("radio", { name: /Leave my changes in the folder/ });
    const save = within(content()).getByRole("radio", { name: /Save them as a commit on main first/ });
    expect(leave.compareDocumentPosition(save) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(leave.getAttribute("aria-checked")).toBe("true");
    expect(within(content()).queryByRole("radio", { name: /recommended/ })).toBeNull();
    const account = within(content()).getByRole("combobox", { name: "GitHub account" }) as HTMLSelectElement;
    expect(account.value).toBe("me");
    await user.selectOptions(account, "work");
    await user.click(await footerButton("Add to Plyloft"));
    await waitFor(() => expect(tauri().callsOf("workspace_set_github_account")).toHaveLength(1));
    expect(tauri().callsOf("workspace_set_github_account")[0].args).toEqual({ id: "new-1", login: "work" });
    await waitFor(() =>
      expect(content().textContent).toContain(
        "Cards start from the last saved version. The changes in 12 files or folders stay in the folder, and cards won't have them.",
      ),
    );
    // Nothing was saved: no look at the work, no commit.
    expect(tauri().callsOf("project_inspect_work")).toHaveLength(0);
    expect(tauri().callsOf("project_save_work")).toHaveLength(0);
  });

  it("changes not saved in Git: Save and add shows what is saved and commits only on the sheet's press", async () => {
    const folder = insp({ uncommittedChanges: true, uncommittedFiles: 3, git: { kind: "branch", branch: "my-work", commit: "abc" } });
    const work = {
      ...folder,
      toSave: { ...summary, files: 3, bytes: 3 * 1024 },
      secrets: [{ path: ".env", bytes: 10 }],
      buildFolders: [{ path: "node_modules/", files: 812 }],
      workFiles: ["math.js", "todo.md", "src/a.js"],
    };
    const { user } = await openStep({
      inspect: { "/Users/me/code/lyra": folder },
      inspectWork: { "/Users/me/code/lyra": work },
    });
    await chooseWay(user, /A folder on this Mac/);
    picked("/Users/me/code/lyra");
    await user.click(await footerButton("Choose a folder"));
    await waitFor(() => expect(content().textContent).toContain("aren't saved in Git yet (3 files or folders)"));
    expect(content().textContent).toContain("One commit in this folder only. Nothing is uploaded.");
    await user.click(within(content()).getByRole("radio", { name: /Save them as a commit on my-work first/ }));
    // Cancel: nothing is written.
    await user.click(await footerButton("Save and add"));
    let sheet = await screen.findByRole("dialog", { name: "Save your current work in “lyra”?" });
    expect(within(sheet).getByText(/one commit on my-work, in this folder only/)).toBeTruthy();
    // A likely secret and a package folder start left out; only lines for
    // them are added, never the first commit's defaults.
    expect((within(sheet).getByRole("checkbox", { name: ".env" }) as HTMLInputElement).checked).toBe(true);
    expect((within(sheet).getByRole("checkbox", { name: /^node_modules\// }) as HTMLInputElement).checked).toBe(true);
    await waitFor(() => expect(tauri().callsOf("project_work_ignore_plan").length).toBeGreaterThan(0));
    expect(tauri().callsOf("project_ignore_plan")).toHaveLength(0);
    expect(sheet.textContent).toContain("Plyloft adds a line to .gitignore for each new file you leave out.");
    // 1.171.0 walk fix: the files it saves, by name.
    expect(within(sheet).getByText("It saves math.js, src/a.js, todo.md.")).toBeTruthy();
    await user.click(within(sheet).getByRole("button", { name: "Cancel" }));
    expect(tauri().callsOf("project_inspect_work")).toHaveLength(1);
    expect(tauri().callsOf("project_save_work")).toHaveLength(0);
    expect(tauri().callsOf("workspace_create")).toHaveLength(0);
    // The sheet's own Save and add: one save, the secret left out, then added.
    await user.click(await footerButton("Save and add"));
    sheet = await screen.findByRole("dialog", { name: "Save your current work in “lyra”?" });
    const go = within(sheet).getByRole("button", { name: "Save and add" });
    await waitFor(() => expect((go as HTMLButtonElement).disabled).toBe(false));
    await user.click(go);
    await waitFor(() => expect(tauri().callsOf("project_save_work")).toHaveLength(1));
    expect(tauri().callsOf("project_save_work")[0].args).toEqual({
      path: "/Users/me/code/lyra",
      choices: { leaveOut: [".env", "node_modules/"], acceptIncomplete: false },
    });
    expect(tauri().callsOf("project_init")).toHaveLength(0);
    await waitFor(() => expect(tauri().callsOf("workspace_create")).toHaveLength(1));
  });

  it("changes not saved in Git while Git is mid-way combining them: only Leave my changes in the folder", async () => {
    const folder = insp({
      uncommittedChanges: true,
      uncommittedFiles: 2,
      workBlocked: "Git is in the middle of combining changes in this folder, so Plyloft won't save them now. Finish that first, or start from the last saved version.",
    });
    const { user } = await openStep({ inspect: { "/Users/me/code/lyra": folder } });
    await chooseWay(user, /A folder on this Mac/);
    picked("/Users/me/code/lyra");
    await user.click(await footerButton("Choose a folder"));
    await waitFor(() => expect(content().textContent).toContain("in the middle of combining changes"));
    expect(within(content()).queryByRole("radio", { name: /Save them as a commit/ })).toBeNull();
    await user.click(await footerButton("Add to Plyloft"));
    await waitFor(() => expect(tauri().callsOf("workspace_create")).toHaveLength(1));
    expect(tauri().callsOf("project_inspect_work")).toHaveLength(0);
  });

  it("a save its project's check refused says so in plain words, Git's output under Details", async () => {
    const folder = insp({ uncommittedChanges: true, uncommittedFiles: 1 });
    const { user } = await openStep({
      inspect: { "/Users/me/code/lyra": folder },
      inspectWork: { "/Users/me/code/lyra": { ...folder, toSave: { ...summary, files: 1, bytes: 1024 } } },
      saveWorkFails:
        "Your project's check before saving refused it, so nothing was saved. A check that tidies files may have changed some of them.\n\nlint: 3 problems",
    });
    await chooseWay(user, /A folder on this Mac/);
    picked("/Users/me/code/lyra");
    await user.click(await footerButton("Choose a folder"));
    await user.click(await waitFor(() => within(content()).getByRole("radio", { name: /Save them as a commit on main first/ })));
    await user.click(await footerButton("Save and add"));
    const sheet = await screen.findByRole("dialog", { name: "Save your current work in “lyra”?" });
    const go = within(sheet).getByRole("button", { name: "Save and add" });
    await waitFor(() => expect((go as HTMLButtonElement).disabled).toBe(false));
    await user.click(go);
    await waitFor(() => expect(within(sheet).getByText(/Your project's check before saving refused it/)).toBeTruthy());
    expect(within(sheet).getByText("What Git said")).toBeTruthy();
    expect(sheet.textContent).toContain("lint: 3 problems");
    expect(tauri().callsOf("workspace_create")).toHaveLength(0);
  });

  it("a first commit in a folder with a github.com origin asks the account too, and stores it", async () => {
    const folder = insp({ outcome: "no-commits", git: { kind: "unborn", branch: "main" }, branches: [], toSave: summary, githubOrigin: "work/lyra" });
    const { user } = await openStep({
      github: status([acct("me", true), acct("work")]),
      inspect: { "/Users/me/code/lyra": folder },
    });
    await chooseWay(user, /A folder on this Mac/);
    picked("/Users/me/code/lyra");
    await user.click(await footerButton("Choose a folder"));
    await waitFor(() => expect(content().textContent).toContain("“lyra” has no saved version yet."));
    await user.selectOptions(within(content()).getByRole("combobox", { name: "GitHub account" }), "work");
    await user.click(await footerButton("Save and add"));
    const sheet = screen.getByRole("dialog", { name: "Save “lyra”'s first version?" });
    const go = within(sheet).getByRole("button", { name: "Save and add" });
    await waitFor(() => expect((go as HTMLButtonElement).disabled).toBe(false));
    await user.click(go);
    await waitFor(() => expect(tauri().callsOf("workspace_set_github_account")[0]?.args).toEqual({ id: "new-1", login: "work" }));
  });

  it("one GitHub account: the account isn't asked", async () => {
    const { user } = await openStep({
      github: status([acct("me", true)]),
      inspect: { "/Users/me/code/lyra": insp({ githubOrigin: "me/lyra" }) },
    });
    await chooseWay(user, /A folder on this Mac/);
    picked("/Users/me/code/lyra");
    await user.click(await footerButton("Choose a folder"));
    await waitFor(() => expect(content().textContent).toContain("is a Git project"));
    expect(within(content()).queryByRole("combobox", { name: "GitHub account" })).toBeNull();
  });
});

// ── 8b ───────────────────────────────────────────────────────────────────

describe("Setup step 8b, from GitHub", () => {
  const several = status([acct("me", true), acct("work")]);

  it("the account only when several; the picker grouped Yours · organisations · Shared · Your team", async () => {
    const repos = [
      repo({}),
      repo({ nameWithOwner: "acme/api", owner: "acme", name: "api", group: "org", groupOwner: "acme", description: "The billing API", isPrivate: false }),
      repo({ nameWithOwner: "friend/notes", owner: "friend", name: "notes", group: "shared", groupOwner: "friend" }),
      repo({ nameWithOwner: "mb/site", owner: "mb", name: "site", group: "team", groupOwner: "mb" }),
    ];
    const { user } = await openStep({ github: status([acct("me", true)]), repos });
    await chooseWay(user, /From GitHub/);
    await waitFor(() => expect(content().textContent).toContain("acme/api"));
    expect(within(content()).queryByRole("combobox", { name: "GitHub account" })).toBeNull();
    const headings = [...content().querySelectorAll(".ux-section-title")].map((h) => h.textContent);
    expect(headings).toEqual(["Yours", "acme", "Shared with you", "Your team"]);
    expect(content().textContent).toContain("Public");
    expect(content().textContent).toContain("The billing API");
    expect(screen.queryByPlaceholderText("Filter repositories")).toBeNull();
    expect(tauri().callsOf("project_repo_list")[0].args).toEqual({ account: null });
  });

  it("several accounts: the select lists them, the active one first chosen; changing it lists that account's", async () => {
    const { user } = await openStep({ github: several, repos: [repo({})] });
    await chooseWay(user, /From GitHub/);
    const select = within(content()).getByRole("combobox", { name: "GitHub account" }) as HTMLSelectElement;
    expect(select.value).toBe("me");
    await waitFor(() => expect(tauri().callsOf("project_repo_list")[0]?.args).toEqual({ account: "me" }));
    await user.selectOptions(select, "work");
    await waitFor(() => expect(last(tauri().callsOf("project_repo_list"))?.args).toEqual({ account: "work" }));
  });

  it("over 12 repositories: a filter field above the list", async () => {
    const repos = Array.from({ length: 13 }, (_, i) => repo({ nameWithOwner: `me/r${i}`, name: `r${i}` }));
    const { user } = await openStep({ github: status([acct("me", true)]), repos });
    await chooseWay(user, /From GitHub/);
    const filter = await screen.findByPlaceholderText("Filter repositories");
    await user.type(filter, "r12");
    await waitFor(() => expect(content().textContent).not.toContain("me/r3"));
    expect(content().textContent).toContain("me/r12");
  });

  it("Get “lyra”? → the clone in the guided terminal → done: registered with its account", async () => {
    const { user } = await openStep({
      github: several,
      repos: [repo({ diskUsageKb: Math.round(2.4 * 1024 * 1024) })],
    });
    tauri().fixture("project_clone", () => {
      tauri().emit("setup://progress", { runId: "run-c", actionId: "project.clone", ptyId: "pty-c", phase: "running", outcome: null, exitCode: null, reprobed: false, tail: [] });
      return { kind: "started", run: CLONE_RUN, path: "/Users/me/Projects/lyra" };
    });
    await chooseWay(user, /From GitHub/);
    await user.click(await within(content()).findByRole("button", { name: "Get" }));
    const sheet = screen.getByRole("dialog", { name: "Get “lyra”?" });
    expect(sheet.textContent).toContain("Plyloft will download it into ~/Projects/lyra.");
    expect(sheet.textContent).toContain("It's 2.4 GB, so this may take a while.");
    expect(sheet.textContent).toContain("gh repo clone me/lyra ~/Projects/lyra -- --progress");
    await user.click(within(sheet).getByRole("button", { name: "Get it" }));
    await waitFor(() => expect(tauri().callsOf("project_clone")).toHaveLength(1));
    expect(tauri().callsOf("project_clone")[0].args).toMatchObject({ repo: "me/lyra", account: "me", destParent: null });
    expect(await screen.findByText("Downloading from GitHub… You can cancel at any time.")).toBeTruthy();
    expect(((await footerButton("Add to Plyloft")) as HTMLButtonElement).disabled).toBe(true);
    emit({ runId: "run-c", phase: "done", outcome: "succeeded", exitCode: 0, clone: cloneDone({}) });
    await waitFor(() => expect(tauri().callsOf("workspace_create")).toHaveLength(1));
    expect(tauri().callsOf("workspace_create")[0].args).toEqual({ cwd: "/Users/me/Projects/lyra", name: "lyra" });
    await waitFor(() => expect(tauri().callsOf("workspace_set_github_account")[0]?.args).toEqual({ id: "new-1", login: "me" }));
    expect(useWorkspaces.getState().activeId).toBe("new-1");
    await waitFor(() => expect(content().textContent).toContain("“lyra” is in Plyloft."));
  });

  it("while the clone runs the way can't change", async () => {
    const { user } = await openStep({ github: status([acct("me", true)]), repos: [repo({})] });
    tauri().fixture("project_clone", { kind: "started", run: CLONE_RUN, path: "/Users/me/Projects/lyra" });
    await chooseWay(user, /From GitHub/);
    await user.click(await within(content()).findByRole("button", { name: "Get" }));
    await user.click(within(screen.getByRole("dialog", { name: "Get “lyra”?" })).getByRole("button", { name: "Get it" }));
    await waitFor(() =>
      expect((within(content()).getByRole("radio", { name: /A new, empty project/ }) as HTMLInputElement).disabled).toBe(true),
    );
    expect(content().textContent).toContain("The download is under way. Cancel it to choose another way.");
    emit({ runId: "run-c", phase: "done", outcome: "cancelled", clone: cloneDone({ cloned: false, failure: { kind: "cancelled", words: "Stopped. Nothing was added to Plyloft.", ssoOrg: null } }) });
    await waitFor(() =>
      expect((within(content()).getByRole("radio", { name: /A new, empty project/ }) as HTMLInputElement).disabled).toBe(false),
    );
  });

  it("Put it somewhere else: the sheet names that folder, the clone goes there, and Try again keeps it", async () => {
    const { user } = await openStep({ github: status([acct("me", true)]), repos: [repo({})] });
    tauri().fixture("project_clone", ({ destParent }: Record<string, unknown>) =>
      destParent
        ? { kind: "started", run: CLONE_RUN, path: "/Volumes/Work/lyra" }
        : { kind: "destination-exists", path: "/Users/me/Projects/lyra", name: "lyra", words: "There's already a folder called “lyra” in Projects." },
    );
    await chooseWay(user, /From GitHub/);
    await user.click(await within(content()).findByRole("button", { name: "Get" }));
    await user.click(within(screen.getByRole("dialog", { name: "Get “lyra”?" })).getByRole("button", { name: "Get it" }));
    await waitFor(() => expect(content().textContent).toContain("There's already a folder called “lyra” in Projects."));
    picked("/Volumes/Work");
    await user.click(within(content()).getByRole("button", { name: "Put it somewhere else" }));
    const sheet = await screen.findByRole("dialog", { name: "Get “lyra”?" });
    expect(sheet.textContent).toContain("Plyloft will download it into /Volumes/Work/lyra.");
    expect(sheet.textContent).toContain("gh repo clone me/lyra /Volumes/Work/lyra -- --progress");
    await user.click(within(sheet).getByRole("button", { name: "Get it" }));
    await waitFor(() => expect(tauri().callsOf("project_clone")).toHaveLength(2));
    expect(tauri().callsOf("project_clone")[1].args).toMatchObject({ destParent: "/Volumes/Work" });
    emit({
      runId: "run-c",
      phase: "done",
      outcome: "failed",
      clone: cloneDone({ cloned: false, failure: { kind: "offline", words: "The download stopped. Nothing was added to Plyloft.", ssoOrg: null } }),
    });
    await user.click(await within(content()).findByRole("button", { name: "Try again" }));
    const again = await screen.findByRole("dialog", { name: "Get “lyra”?" });
    expect(again.textContent).toContain("Plyloft will download it into /Volumes/Work/lyra.");
    await user.click(within(again).getByRole("button", { name: "Get it" }));
    await waitFor(() => expect(tauri().callsOf("project_clone")).toHaveLength(3));
    expect(tauri().callsOf("project_clone")[2].args).toMatchObject({ destParent: "/Volumes/Work" });
  });

  it("Cancel stops the clone; nothing is added", async () => {
    const { user } = await openStep({ github: status([acct("me", true)]), repos: [repo({})] });
    tauri().fixture("project_clone", { kind: "started", run: CLONE_RUN, path: "/Users/me/Projects/lyra" });
    await chooseWay(user, /From GitHub/);
    await user.click(await within(content()).findByRole("button", { name: "Get" }));
    await user.click(within(screen.getByRole("dialog", { name: "Get “lyra”?" })).getByRole("button", { name: "Get it" }));
    await user.click(await within(content()).findByRole("button", { name: "Cancel" }));
    expect(tauri().callsOf("setup_stop")[0].args).toEqual({ runId: "run-c" });
    emit({
      runId: "run-c",
      phase: "done",
      outcome: "cancelled",
      clone: cloneDone({ cloned: false, removedPartial: true, failure: { kind: "cancelled", words: "Stopped. Nothing was added to Plyloft.", ssoOrg: null } }),
    });
    await waitFor(() => expect(content().textContent).toContain("Stopped. Nothing was added to Plyloft."));
    expect(tauri().callsOf("workspace_create")).toHaveLength(0);
  });

  it("the destination exists → Add that folder instead goes to 8a with it", async () => {
    const { user } = await openStep({
      github: status([acct("me", true)]),
      repos: [repo({})],
      inspect: { "/Users/me/Projects/lyra": insp({ path: "/Users/me/Projects/lyra" }) },
    });
    tauri().fixture("project_clone", {
      kind: "destination-exists",
      path: "/Users/me/Projects/lyra",
      name: "lyra",
      words: "There's already a folder called “lyra” in Projects.",
    });
    await chooseWay(user, /From GitHub/);
    await user.click(await within(content()).findByRole("button", { name: "Get" }));
    await user.click(within(screen.getByRole("dialog", { name: "Get “lyra”?" })).getByRole("button", { name: "Get it" }));
    await waitFor(() => expect(content().textContent).toContain("There's already a folder called “lyra” in Projects."));
    await user.click(within(content()).getByRole("button", { name: "Add that folder instead" }));
    await waitFor(() => expect(content().textContent).toContain("“lyra” is a Git project on branch main."));
    expect(tauri().callsOf("project_inspect").some((c) => c.args.path === "/Users/me/Projects/lyra")).toBe(true);
  });

  it("already in Plyloft elsewhere → Open it", async () => {
    const { user } = await openStep({
      github: status([acct("me", true)]),
      repos: [repo({})],
      workspaces: [ws("w5", "lyra", "/Users/me/work/lyra")],
    });
    tauri().fixture("project_clone", {
      kind: "already-in-ply",
      workspace: { id: "w5", name: "lyra", cwd: "/Users/me/work/lyra" },
      words: "lyra is already in Plyloft, at ~/work/lyra.",
    });
    await chooseWay(user, /From GitHub/);
    await user.click(await within(content()).findByRole("button", { name: "Get" }));
    await user.click(within(screen.getByRole("dialog", { name: "Get “lyra”?" })).getByRole("button", { name: "Get it" }));
    await waitFor(() => expect(content().textContent).toContain("lyra is already in Plyloft, at ~/work/lyra."));
    await user.click(await footerButton("Open it"));
    await waitFor(() => expect(last(tauri().callsOf("workspace_set_active"))?.args).toEqual({ id: "w5" }));
    expect(tauri().callsOf("workspace_create")).toHaveLength(0);
  });

  it("empty on GitHub → Make the first commit (sheet with Details) or Keep it empty", async () => {
    const { user } = await openStep({ github: status([acct("me", true)]), repos: [repo({ isEmpty: true, diskUsageKb: 0 })] });
    tauri().fixture("project_clone", { kind: "started", run: CLONE_RUN, path: "/Users/me/Projects/lyra" });
    await chooseWay(user, /From GitHub/);
    await user.click(await within(content()).findByRole("button", { name: "Get" }));
    const sheet = screen.getByRole("dialog", { name: "Get “lyra”?" });
    expect(sheet.textContent).toContain("It's empty on GitHub.");
    await user.click(within(sheet).getByRole("button", { name: "Get it" }));
    await waitFor(() => expect(tauri().callsOf("project_clone")).toHaveLength(1));
    emit({ runId: "run-c", phase: "done", outcome: "succeeded", exitCode: 0, clone: cloneDone({ empty: true }) });
    await waitFor(() => expect(content().textContent).toContain("“lyra” is empty on GitHub."));
    expect(content().textContent).toContain(
      "Plyloft will add a README and save it as the first commit, then send it to GitHub so both have the same start.",
    );
    expect(tauri().callsOf("workspace_create")).toHaveLength(0);
    await user.click(await footerButton("Make the first commit"));
    const push = screen.getByRole("dialog", { name: "Make “lyra”'s first commit?" });
    expect(push.textContent).toContain("git push -u origin main");
    await user.click(within(push).getByRole("button", { name: "Make the first commit" }));
    await waitFor(() => expect(tauri().callsOf("project_first_commit_push")[0]?.args).toEqual({ path: "/Users/me/Projects/lyra", account: null }));
    await waitFor(() => expect(tauri().callsOf("workspace_create")).toHaveLength(1));
  });

  it("empty → Keep it empty registers it without a commit", async () => {
    const { user } = await openStep({ github: status([acct("me", true)]), repos: [repo({ isEmpty: true })] });
    tauri().fixture("project_clone", { kind: "started", run: CLONE_RUN, path: "/Users/me/Projects/lyra" });
    await chooseWay(user, /From GitHub/);
    await user.click(await within(content()).findByRole("button", { name: "Get" }));
    await user.click(within(screen.getByRole("dialog", { name: "Get “lyra”?" })).getByRole("button", { name: "Get it" }));
    await waitFor(() => expect(tauri().callsOf("project_clone")).toHaveLength(1));
    emit({ runId: "run-c", phase: "done", outcome: "succeeded", exitCode: 0, clone: cloneDone({ empty: true }) });
    await user.click(await within(content()).findByRole("button", { name: "Keep it empty" }));
    await waitFor(() => expect(tauri().callsOf("workspace_create")).toHaveLength(1));
    expect(tauri().callsOf("project_first_commit_push")).toHaveLength(0);
  });

  it("auth failure: one account → Fix sign-in opens the GitHub step; several → try another account", async () => {
    const failed = cloneDone({
      cloned: false,
      removedPartial: true,
      failure: { kind: "auth", words: "GitHub didn't let this account download lyra.", ssoOrg: null },
    });
    const { user } = await openStep({ github: status([acct("me", true)]), repos: [repo({})] });
    tauri().fixture("project_clone", { kind: "started", run: CLONE_RUN, path: "/Users/me/Projects/lyra" });
    await chooseWay(user, /From GitHub/);
    await user.click(await within(content()).findByRole("button", { name: "Get" }));
    await user.click(within(screen.getByRole("dialog", { name: "Get “lyra”?" })).getByRole("button", { name: "Get it" }));
    await waitFor(() => expect(tauri().callsOf("project_clone")).toHaveLength(1));
    emit({ runId: "run-c", phase: "done", outcome: "failed", exitCode: 1, clone: failed });
    await waitFor(() => expect(content().textContent).toContain("GitHub didn't let this account download lyra."));
    await user.click(within(content()).getByRole("button", { name: "Fix sign-in" }));
    await waitFor(() => expect(stepTitle()).toBe("Connect GitHub for your projects"));
  });

  it("auth failure with several accounts says to try another one", async () => {
    const { user } = await openStep({ github: several, repos: [repo({})] });
    tauri().fixture("project_clone", { kind: "started", run: CLONE_RUN, path: "/Users/me/Projects/lyra" });
    await chooseWay(user, /From GitHub/);
    await user.click(await within(content()).findByRole("button", { name: "Get" }));
    await user.click(within(screen.getByRole("dialog", { name: "Get “lyra”?" })).getByRole("button", { name: "Get it" }));
    await waitFor(() => expect(tauri().callsOf("project_clone")).toHaveLength(1));
    emit({
      runId: "run-c",
      phase: "done",
      outcome: "failed",
      clone: cloneDone({ cloned: false, failure: { kind: "auth", words: "GitHub didn't let this account download lyra.", ssoOrg: null } }),
    });
    await waitFor(() =>
      expect(content().textContent).toContain("GitHub didn't let this account download lyra. Try with another account."),
    );
    expect(within(content()).queryByRole("button", { name: "Fix sign-in" })).toBeNull();
  });

  it("leaving the step while the clone runs asks first: Stop the download?", async () => {
    const { user } = await openStep({ github: status([acct("me", true)]), repos: [repo({})] });
    tauri().fixture("project_clone", { kind: "started", run: CLONE_RUN, path: "/Users/me/Projects/lyra" });
    await chooseWay(user, /From GitHub/);
    await user.click(await within(content()).findByRole("button", { name: "Get" }));
    await user.click(within(screen.getByRole("dialog", { name: "Get “lyra”?" })).getByRole("button", { name: "Get it" }));
    await waitFor(() => expect(tauri().callsOf("project_clone")).toHaveLength(1));
    await user.click(within(stepList()).getByRole("button", { name: /Ready/ }));
    const ask = screen.getByRole("dialog", { name: "Stop the download?" });
    expect(ask.textContent).toContain("Stopping removes what was downloaded so far; nothing is added to Plyloft.");
    await user.click(within(ask).getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(tauri().callsOf("setup_stop")).toHaveLength(1));
  });
});

// ── 8c ───────────────────────────────────────────────────────────────────

describe("Setup step 8c, a new, empty project", () => {
  it("the folder is shown live; the GitHub copy is off by default and the sheet names only local commands", async () => {
    const { user } = await openStep({ github: status([acct("me", true)]) });
    await chooseWay(user, /A new, empty project/);
    await user.type(within(content()).getByRole("textbox", { name: "Name" }), "My app");
    await waitFor(() => expect(content().textContent).toContain("It goes in ~/Projects/my-app."));
    const copy = within(content()).getByRole("checkbox", { name: /Also keep a private copy on GitHub/ }) as HTMLInputElement;
    expect(copy.checked).toBe(false);
    expect(content().textContent).toContain("Creates the private repository me/my-app and sends the first version.");
    await user.click(await footerButton("Create project"));
    const sheet = screen.getByRole("dialog", { name: "Create “My app”?" });
    expect(sheet.textContent).toContain("Plyloft will make the folder, start Git in it and save a first version with a README.");
    expect(sheet.textContent).toContain("mkdir ~/Projects/my-app");
    expect(sheet.textContent).toContain('git commit -m "Start My app"');
    expect(sheet.textContent).not.toContain("gh repo create");
    await user.click(within(sheet).getByRole("button", { name: "Create project" }));
    await waitFor(() => expect(tauri().callsOf("project_new")[0]?.args).toEqual({ request: { name: "My app", parent: null, githubCopy: null } }));
    await waitFor(() => expect(tauri().callsOf("workspace_create")[0]?.args).toEqual({ cwd: "/Users/me/Projects/my-app", name: "My app" }));
    expect(useWorkspaces.getState().activeId).toBe("new-1");
  });

  it("ticked, the copy is named in the sheet and asked for; a taken name keeps the local project", async () => {
    const { user } = await openStep({
      github: status([acct("me", true)]),
      created: {
        kind: "created",
        path: "/Users/me/Projects/my-app",
        name: "My app",
        slug: "my-app",
        branch: "main",
        commit: "c1",
        github: { state: "name-taken", repo: "me/my-app", words: null },
      },
    });
    await chooseWay(user, /A new, empty project/);
    await user.type(within(content()).getByRole("textbox", { name: "Name" }), "My app");
    await waitFor(() => expect(content().textContent).toContain("It goes in ~/Projects/my-app."));
    await user.click(within(content()).getByRole("checkbox", { name: /Also keep a private copy on GitHub/ }));
    await user.click(await footerButton("Create project"));
    const sheet = screen.getByRole("dialog", { name: "Create “My app”?" });
    expect(sheet.textContent).toContain("Then it creates the private repository me/my-app on GitHub and sends that version.");
    expect(sheet.textContent).toContain("gh repo create me/my-app --private --source . --push");
    await user.click(within(sheet).getByRole("button", { name: "Create project" }));
    await waitFor(() => expect(tauri().callsOf("project_new")[0]?.args).toMatchObject({ request: { githubCopy: { login: "me" } } }));
    await waitFor(() =>
      expect(content().textContent).toContain(
        "You already have a repository called my-app on GitHub. The project was made on this computer; no copy was sent.",
      ),
    );
    expect(tauri().callsOf("workspace_create")).toHaveLength(1);
  });

  it("without GitHub there is no copy to offer", async () => {
    const { user } = await openStep();
    await chooseWay(user, /A new, empty project/);
    expect(within(content()).queryByRole("checkbox", { name: /private copy/ })).toBeNull();
  });

  it.each([
    ["symbols only", "!!!", "Choose a name with letters or numbers."],
    ["a reserved name", "con", "Choose a name with letters or numbers."],
    [
      "a name in Japanese",
      "日本語",
      "The folder's name can only use the letters a to z and numbers. Add some to the name, like “Notes 2”.",
    ],
  ])("%s is refused in words", async (_n, name, words) => {
    const { user } = await openStep({
      preview: (typed) => ({
        name: typed,
        slug: null,
        path: null,
        displayPath: null,
        folder: null,
        insideRepo: null,
        problem: "Choose a name with letters or numbers.",
        placeRefused: false,
      }),
    });
    await chooseWay(user, /A new, empty project/);
    await user.type(within(content()).getByRole("textbox", { name: "Name" }), name);
    await waitFor(() => expect(content().textContent).toContain(words));
    expect(((await footerButton("Create project")) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a folder with files → Add that folder instead (8a) · Choose another name", async () => {
    const { user } = await openStep({
      inspect: { "/Users/me/Projects/my-app": insp({ path: "/Users/me/Projects/my-app", name: "my-app" }) },
      preview: (typed) => ({
        name: typed,
        slug: "my-app",
        path: "/Users/me/Projects/my-app",
        displayPath: "~/Projects/my-app",
        folder: "has-files",
        insideRepo: null,
        problem: "There's already a folder called “my-app” with files in it.",
        placeRefused: false,
      }),
    });
    await chooseWay(user, /A new, empty project/);
    await user.type(within(content()).getByRole("textbox", { name: "Name" }), "My app");
    await waitFor(() => expect(content().textContent).toContain("There's already a folder called “my-app” with files in it."));
    expect(within(content()).getByRole("button", { name: "Choose another name" })).toBeTruthy();
    expect(((await footerButton("Create project")) as HTMLButtonElement).disabled).toBe(true);
    await user.click(within(content()).getByRole("button", { name: "Add that folder instead" }));
    await waitFor(() => expect(content().textContent).toContain("“my-app” is a Git project on branch main."));
  });
});

// ── The fast checklist ───────────────────────────────────────────────────

describe("Just the essentials: the project row", () => {
  it("no Projects folder row (F2: it's in the project step); First project opens the step", async () => {
    const { user } = await openStep({ level: "fast", step: "ready" });
    // Back to the checklist.
    await user.click(await footerButton("Back"));
    const row = (label: string) =>
      screen.getByText(label, { selector: ".ux-row-label, .ux-row-label *" }).closest(".ux-row") as HTMLElement;
    await waitFor(() => expect(row("Your first project")).toBeTruthy());
    expect(screen.queryByText("Where your projects live")).toBeNull();
    expect(screen.queryByRole("button", { name: "Use this folder" })).toBeNull();
    expect(tauri().callsOf("projects_folder_create")).toHaveLength(0);
    await user.click(within(row("Your first project")).getByRole("button", { name: "Add a project" }));
    await waitFor(() => expect(stepTitle()).toBe("Your first project"));
  });
});

// ── QoL 7.2 (B2): the one Add a project sheet ───────────────────────────

describe("Add a project, outside Setup", () => {
  const sheet = () => screen.getByRole("dialog", { name: "Add a project" });
  const sheetButton = (name: string) => waitFor(() => within(sheet()).getByRole("button", { name }));

  it("offers the three ways, adds a folder and opens its Board at once", async () => {
    const { user } = await openStep({
      sheet: true,
      workspaces: [ws("w1", "atlas", "/a")],
      github: status([acct("me", true)]),
      inspect: { "/Users/me/code/lyra": insp({}) },
    });
    expect(sheet().textContent).toContain("A folder on this Mac, one from GitHub, or a new one.");
    expect(within(sheet()).getByRole("radio", { name: /A folder on this Mac/ })).toBeTruthy();
    expect(within(sheet()).getByRole("radio", { name: /From GitHub/ })).toBeTruthy();
    expect(within(sheet()).getByRole("radio", { name: /new/i })).toBeTruthy();
    // Nothing to open yet: no disabled "Open its Board" before a way.
    expect(within(sheet()).queryByRole("button", { name: "Open its Board" })).toBeNull();
    await user.click(within(sheet()).getByRole("radio", { name: /A folder on this Mac/ }));
    picked("/Users/me/code/lyra");
    await user.click(await sheetButton("Choose a folder"));
    await waitFor(() => expect(sheet().textContent).toContain("“lyra” is a Git project on branch main."));
    // Its plain build settings are read after (autoSetUp, best effort).
    tauri().allowUnhandled();
    await user.click(await sheetButton("Add to Plyloft"));
    // 1.174.0 C16 (NIW-6): no step after Add to Plyloft — the sheet closes
    // onto the Board, and a toast says it is in.
    await waitFor(() => expect(useAddProject.getState().open).toBe(false));
    expect(tauri().callsOf("workspace_create")[0].args).toEqual({ cwd: "/Users/me/code/lyra", name: "lyra" });
    expect(screen.queryByRole("button", { name: "Open its Board" })).toBeNull();
    expect(useToasts.getState().recent.some((t) => t.title === "lyra is in Plyloft.")).toBe(true);
    await waitFor(() => expect(useWorkspaces.getState().activeId).toBe("new-1"));
    await waitFor(() => expect(useUi.getState().centerMode["new-1"]).toBe("board"));
    // Its plain build settings are read for it (autoSetUp), as the old
    // folder picker did.
    await waitFor(() =>
      expect(tauri().callsOf("project_detect_for_setup").some((c) => c.args.workspaceId === "new-1")).toBe(true),
    );
  });

  // C16 round 1: the keyboard goes into the new project's Board.
  it("after it closes, the keyboard is in the Board's page", async () => {
    const host = document.createElement("div");
    host.className = "center-mode-host";
    const main = document.createElement("main");
    main.textContent = "Board";
    host.appendChild(main);
    document.body.appendChild(host);
    try {
      const { user } = await openStep({
        sheet: true,
        workspaces: [ws("w1", "atlas", "/a")],
        github: status([acct("me", true)]),
        inspect: { "/Users/me/code/lyra": insp({}) },
      });
      tauri().allowUnhandled();
      await user.click(within(sheet()).getByRole("radio", { name: /A folder on this Mac/ }));
      picked("/Users/me/code/lyra");
      await user.click(await sheetButton("Choose a folder"));
      await user.click(await sheetButton("Add to Plyloft"));
      await waitFor(() => expect(useAddProject.getState().open).toBe(false));
      await waitFor(() => expect(main.contains(document.activeElement)).toBe(true));
    } finally {
      host.remove();
    }
  });

  // C16 round 1: a note that says something failed isn't only a toast — the
  // sheet keeps it, with Open its Board.
  it("a copy on GitHub that failed stays in the sheet until Open its Board", async () => {
    const failed = "The copy on GitHub couldn't be made. The project was made on this computer.";
    const { user } = await openStep({
      sheet: true,
      workspaces: [ws("w1", "atlas", "/a")],
      github: status([acct("me", true)]),
      created: {
        kind: "created",
        path: "/Users/me/Projects/my-app",
        name: "My app",
        slug: "my-app",
        branch: "main",
        commit: "c1",
        github: { state: "failed", repo: "me/my-app", words: null },
      },
    });
    tauri().allowUnhandled();
    // Before a way is chosen there is no primary at all.
    expect(within(sheet()).queryByRole("button", { name: "Open its Board" })).toBeNull();
    await user.click(within(sheet()).getByRole("radio", { name: /new/i }));
    await user.type(within(sheet()).getByRole("textbox", { name: "Name" }), "My app");
    await waitFor(() => expect(sheet().textContent).toContain("It goes in ~/Projects/my-app."));
    await user.click(within(sheet()).getByRole("checkbox", { name: /Also keep a private copy on GitHub/ }));
    await user.click(await sheetButton("Create project"));
    const confirm = await screen.findByRole("dialog", { name: "Create “My app”?" });
    await user.click(within(confirm).getByRole("button", { name: "Create project" }));
    await waitFor(() => expect(sheet().textContent).toContain(failed));
    expect(sheet().textContent).toContain("“My app” is in Plyloft.");
    expect(useAddProject.getState().open).toBe(true);
    expect(useToasts.getState().recent.some((t) => t.title === "My app is in Plyloft.")).toBe(false);
    await user.click(await sheetButton("Open its Board"));
    await waitFor(() => expect(useAddProject.getState().open).toBe(false));
    await waitFor(() => expect(useUi.getState().centerMode["new-1"]).toBe("board"));
    // Already said in the sheet: no toast on top.
    expect(useToasts.getState().recent.some((t) => t.title === "My app is in Plyloft.")).toBe(false);
  });

  // 1.174.0 C16 (NIW-6): a folder with changes not saved in Git — the
  // default writes nothing, and the sheet closes onto the Board at once with
  // what the sheet used to say under the toast.
  it("a folder with changes: the default writes nothing and the Board opens at once", async () => {
    const { user } = await openStep({
      sheet: true,
      workspaces: [ws("w1", "atlas", "/a")],
      github: status([acct("me", true)]),
      inspect: { "/Users/me/code/lyra": insp({ uncommittedChanges: true, uncommittedFiles: 2 }) },
    });
    tauri().allowUnhandled();
    await user.click(within(sheet()).getByRole("radio", { name: /A folder on this Mac/ }));
    picked("/Users/me/code/lyra");
    await user.click(await sheetButton("Choose a folder"));
    const leave = await waitFor(() => within(sheet()).getByRole("radio", { name: /Leave my changes in the folder/ }));
    expect(leave.getAttribute("aria-checked")).toBe("true");
    await user.click(await sheetButton("Add to Plyloft"));
    await waitFor(() => expect(useAddProject.getState().open).toBe(false));
    expect(tauri().callsOf("project_inspect_work")).toHaveLength(0);
    expect(tauri().callsOf("project_save_work")).toHaveLength(0);
    await waitFor(() => expect(useUi.getState().centerMode["new-1"]).toBe("board"));
    const told = useToasts.getState().recent.find((t) => t.title === "lyra is in Plyloft.");
    expect(told?.body).toBe(
      "Cards start from the last saved version. The changes in 2 files or folders stay in the folder, and cards won't have them.",
    );
  });

  // 1.171.0 walk fix: a folder with no origin, on a branch beside main, is
  // set up for builds as soon as it is added — Start build isn't stopped by
  // "isn't set up yet".
  it("sets the added folder up at once", async () => {
    const { user } = await openStep({
      sheet: true,
      workspaces: [ws("w1", "atlas", "/a")],
      github: status([acct("me", true)]),
      inspect: { "/Users/me/code/lyra": insp({}) },
    });
    tauri().fixture("workspace_definition_get", null);
    tauri().fixture("project_local_origin", { hasOrigin: false, defaultBranch: null });
    tauri().fixture("project_detect_for_setup", {
      state: "proposal",
      config: { schemaVersion: 2, targetBranch: "feature", versionFiles: [], installScript: null, verifyPipeline: null, createdAt: 0, updatedAt: 0 },
      branches: ["main", "feature"],
      suggestedBranch: null,
      branchFrom: "head",
      head: "branch",
      headBranch: "feature",
      detectedVerify: null,
      version: null,
    });
    tauri().fixture("project_config_set", null);
    tauri().allowUnhandled();
    expect(sheet().textContent).toContain("You already have 1 project in Plyloft.");
    await user.click(within(sheet()).getByRole("radio", { name: /A folder on this Mac/ }));
    picked("/Users/me/code/lyra");
    await user.click(await sheetButton("Choose a folder"));
    await user.click(await sheetButton("Add to Plyloft"));
    await waitFor(() => expect(useAddProject.getState().open).toBe(false));
    await waitFor(() => expect(tauri().callsOf("project_config_set").length).toBe(1));
    expect(tauri().callsOf("project_config_set")[0].args.workspaceId).toBe("new-1");
    expect((tauri().callsOf("project_config_set")[0].args.config as { targetBranch: string }).targetBranch).toBe("feature");
    // Challenger 1: a branch only Add a project's rule takes is said, with Change.
    await waitFor(() =>
      expect(useToasts.getState().toasts.some((t) =>
        t.body === "Cards start from feature and are merged back into it. Change it in Settings › Cards › Shipping.",
      )).toBe(true),
    );
    const told = useToasts.getState().toasts.find((t) => t.title === "“lyra” is set up for builds");
    expect(told?.action?.label).toBe("Change");
  });

  it("names this PC on Windows", async () => {
    setPlatformForTests("windows");
    await openStep({ sheet: true });
    expect(sheet().textContent).toContain("A folder on this PC, one from GitHub, or a new one.");
  });

  it("a folder Plyloft can't read says so in the sheet, not only in the console", async () => {
    const { user } = await openStep({ sheet: true });
    tauri().fixture("project_inspect", () => {
      throw "Plyloft couldn't open that folder: permission denied.";
    });
    await user.click(within(sheet()).getByRole("radio", { name: /A folder on this Mac/ }));
    picked("/Users/me/locked");
    await user.click(await sheetButton("Choose a folder"));
    await waitFor(() => expect(sheet().textContent).toContain("permission denied"));
    expect(useAddProject.getState().open).toBe(true);
  });

  it("Cancel closes it and adds nothing", async () => {
    const { user } = await openStep({ sheet: true });
    await user.click(await sheetButton("Cancel"));
    expect(useAddProject.getState().open).toBe(false);
    expect(tauri().callsOf("workspace_create")).toHaveLength(0);
  });
});
