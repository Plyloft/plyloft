// OB-6 (ONBOARDING_SPEC §5 step 4): Setup's "Git and your name" step,
// rendered inside Setup — the Git row per platform and its install through
// the runner after the consent sheet, the CLT wait and its failure, the
// identity fields prefilled, GitHub's private address, the inline email
// error, `Save to Git` → sheet → write, and "Git knows you as …" + Change.
import { afterEach, describe, expect, it, vi } from "vitest";
import { SetupOverlay } from "../components/SetupOverlay";
import { ProfilePage } from "../components/settings/ProfilePage";
import { useSetup } from "../store/setupStore";
import { useSetupRun } from "../store/setupRunStore";
import { useWorkspaces } from "../store/workspaceStore";
import { DEFAULT_SETTINGS, useSettings, type Settings } from "../store/settingsStore";
import { setPlatformForTests } from "../lib/platform";
import type { GitIdentityStatus, IdentityPrefill, SetupProgressEvent, SetupStarted } from "../ipc";
import { act, nextFrame, renderUi, screen, waitFor, within } from "./render";
import { tauri } from "./tauri";

// xterm draws on a canvas jsdom does not have.
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
  act(() => useSetup.setState({ open: false, step: null }));
});

const WINGET = "winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements";

type Tool = { id: string; found: boolean; versionOk: boolean; path?: string | null; version?: string | null; installCmd?: string };
const gitOk: Tool = { id: "git", found: true, versionOk: true, path: "/usr/bin/git", version: "2.39.5", installCmd: "xcode-select --install" };
const gitNoClt: Tool = { id: "git", found: false, versionOk: false, path: "/usr/bin/git", version: null, installCmd: "xcode-select --install" };

const NO_PREFILL: IdentityPrefill = {
  name: "",
  nameSource: "none",
  email: "",
  emailSource: "none",
  githubNoreply: null,
  githubLogin: null,
};

const identity = (name: string | null, email: string | null): GitIdentityStatus => ({
  name,
  email,
  set: Boolean(name && email),
  detail: "",
});

interface Opts {
  tools?: Tool[];
  gitIdentity?: GitIdentityStatus | null;
  prefill?: IdentityPrefill;
  fixtures?: Record<string, unknown>;
  /** 1.175.0 F1: the yes kept from the GitHub step's sheet. */
  gitHelperConsented?: boolean;
}

async function openGit(o: Opts = {}) {
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    onboarding: { ...DEFAULT_SETTINGS.onboarding, level: "guided", gitHelperConsented: o.gitHelperConsented ?? false },
  };
  let gitIdentity = o.gitIdentity ?? null;
  act(() => {
    useSettings.setState({ settings, loaded: true });
    useWorkspaces.setState({ workspaces: [], activeId: null });
    useSetupRun.setState({ run: null, phase: null, outcome: null, tail: [], error: null });
  });
  const r = renderUi(<SetupOverlay />, {
    fixtures: {
      settings_set: ({ settings: next }: Record<string, unknown>) => next,
      dependency_doctor: () => ({
        tools: o.tools ?? [gitOk, { id: "claude", found: true, versionOk: true }],
        allRequiredOk: true,
        gitIdentity,
        whisperModel: { model: "small", present: false, path: null, detail: "Not downloaded." },
      }),
      team_work_mode: { mode: "solo", chosen: true },
      team_status: { teamRepo: null, teamName: null, hasClone: false },
      project_config_list: [],
      build_cache_status: null,
      setup_identity_prefill: o.prefill ?? NO_PREFILL,
      setup_identity_write: ({ name, email }: Record<string, unknown>) => {
        gitIdentity = identity(String(name), String(email));
        return { name, email };
      },
      setup_active: null,
      pty_resize: null,
      ...o.fixtures,
    },
  });
  // Diagnostics' identity `Set` (and Profile) open Setup this way.
  act(() => useSetup.getState().openSetup("rerun", "git"));
  await nextFrame();
  await waitFor(() => expect(document.querySelector(".ux-setup-steptitle")?.textContent).toBe("Git and your name"));
  return r;
}

const footer = () => document.querySelector(".ux-setup-foot") as HTMLElement;
const footerButton = (name: string) => within(footer()).getByRole("button", { name });
const field = (name: string) => screen.getByRole("textbox", { name }) as HTMLInputElement;

function progress(run: SetupStarted, over: Partial<SetupProgressEvent>): SetupProgressEvent {
  return {
    runId: run.runId,
    actionId: run.actionId,
    ptyId: run.ptyId,
    phase: "running",
    outcome: null,
    exitCode: null,
    reprobed: false,
    tail: [],
    ...over,
  };
}

const CLT_RUN: SetupStarted = {
  runId: "run-git",
  actionId: "install.git",
  ptyId: "pty-git",
  display: "xcode-select --install",
  watch: { kind: "command-line-tools" },
};

describe("Setup step 4, the Git row", () => {
  it("git missing on the Mac: Install → the CLT sheet → the runner, the wait line, then the installer closed", async () => {
    const { user, tauri: stub } = await openGit({
      tools: [gitNoClt],
      fixtures: {
        setup_run: () => {
          tauri().emit("setup://progress", progress(CLT_RUN, {}));
          return CLT_RUN;
        },
        setup_open_git_downloads: null,
      },
    });
    expect(screen.getByText("Not installed.")).toBeTruthy();
    expect(screen.getByText("Install Git first. Then Plyloft can save your name and email.")).toBeTruthy();
    // One primary, named by its outcome; the fields wait for Git.
    expect(field("Name").disabled).toBe(true);
    await user.click(footerButton("Install"));

    const sheet = screen.getByRole("dialog", { name: "Install Apple's developer tools?" });
    expect(sheet.textContent).toContain(
      "macOS installs Git with its Command Line Tools. A macOS window will ask you to confirm; it can take a few minutes.",
    );
    expect(within(sheet).getByText("xcode-select --install")).toBeTruthy();
    expect(stub.callsOf("setup_run")).toEqual([]);
    await user.click(within(sheet).getByRole("button", { name: "Install" }));

    await waitFor(() => expect(stub.callsOf("setup_run")).toHaveLength(1));
    // Only the action id crosses.
    expect(stub.callsOf("setup_run")[0].args).toEqual({ actionId: "install.git", args: null, cols: null, rows: null });
    expect(await screen.findByText("Waiting for the macOS installer to finish…")).toBeTruthy();
    expect(screen.getByText("Installing")).toBeTruthy();
    expect((footerButton("Install") as HTMLButtonElement).disabled).toBe(true);

    // The macOS window closed without the tools.
    act(() => tauri().emit("setup://progress", progress(CLT_RUN, { phase: "done", outcome: "installer-closed" })));
    const titles = await screen.findAllByText("The macOS installer was closed before Git was installed.");
    expect(titles.length).toBeGreaterThan(0);
    expect(screen.getByText(/macOS needs an administrator to install the developer tools/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Do it yourself" }));
    expect(stub.callsOf("setup_open_git_downloads")).toHaveLength(1);
  });

  it("git ready on the Mac says its version and asks for nothing", async () => {
    await openGit({ gitIdentity: identity("Matteo Braghetta", "m@example.com") });
    expect(screen.queryByText(/Install Git for Windows runs its installer/)).toBeNull();
    expect(screen.getByText("Installed (git 2.39.5).")).toBeTruthy();
    const row = screen.getByText("Installed (git 2.39.5).").closest(".ux-row") as HTMLElement;
    expect(within(row).getByText("Ready")).toBeTruthy();
  });

  it("Windows: Git for Windows, and a git without Git Bash installs it with --force", async () => {
    setPlatformForTests("windows");
    const { user } = await openGit({
      tools: [
        { id: "git", found: true, versionOk: true, installCmd: WINGET },
        { id: "git-bash", found: false, versionOk: false, installCmd: `${WINGET} --force` },
      ],
    });
    expect(screen.getByText("Git for Windows")).toBeTruthy();
    expect(screen.getByText("Git works, but Git Bash wasn't found. Plyloft needs it to run project checks.")).toBeTruthy();
    // 1.176.4: what Install does, before the press.
    expect(screen.getByText("Install Git for Windows runs its installer through winget, Windows' package installer. Windows may ask for an administrator's permission.")).toBeTruthy();
    await user.click(footerButton("Install Git for Windows"));
    const sheet = screen.getByRole("dialog", { name: "Install Git for Windows?" });
    expect(within(sheet).getByText(`${WINGET} --force`)).toBeTruthy();
  });
});

describe("Setup step 4, your name and email", () => {
  it("prefilled, the email checked inline, then Save to Git → the sheet → the write, and Git knows you", async () => {
    const { user, tauri: stub } = await openGit({
      prefill: { ...NO_PREFILL, name: "Matteo Braghetta", nameSource: "system" },
    });
    await waitFor(() => expect(field("Name").value).toBe("Matteo Braghetta"));
    expect(field("Email").value).toBe("");

    // Invalid: inline, no sheet, nothing written.
    await user.type(field("Email"), "matteo");
    await user.click(footerButton("Save to Git"));
    expect(screen.getByText("That doesn't look like an email address.")).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Set your Git name and email?" })).toBeNull();

    // Fixed: the error goes as the field changes.
    await user.type(field("Email"), "@example.com");
    expect(screen.queryByText("That doesn't look like an email address.")).toBeNull();
    await user.click(footerButton("Save to Git"));
    const sheet = screen.getByRole("dialog", { name: "Set your Git name and email?" });
    expect(sheet.textContent).toContain("Every Git project on this Mac uses these unless it sets its own.");
    expect(sheet.textContent).toContain('git config --global user.name "Matteo Braghetta"');
    expect(sheet.textContent).toContain('git config --global user.email "matteo@example.com"');
    expect(stub.callsOf("setup_identity_write")).toEqual([]);

    await user.click(within(sheet).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(stub.callsOf("setup_identity_write")).toHaveLength(1));
    expect(stub.callsOf("setup_identity_write")[0].args).toEqual({
      name: "Matteo Braghetta",
      email: "matteo@example.com",
    });
    expect(await screen.findByText("Git knows you as Matteo Braghetta <matteo@example.com>.")).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Set your Git name and email?" })).toBeNull();
    // The doctor is read again, and the step turns done from it.
    await waitFor(() => expect(footerButton("Continue")).toBeTruthy());
    await waitFor(() =>
      expect(
        within(screen.getByRole("navigation", { name: "Setup steps" })).getByRole("button", { name: /Git and your name/ }).textContent,
      ).toContain("Done"),
    );
  });

  it("a private GitHub email: the private address is the default, another email is a choice", async () => {
    const noreply = "1234567+matteo@users.noreply.github.com";
    const { user, tauri: stub } = await openGit({
      prefill: {
        name: "Matteo B",
        nameSource: "github",
        email: noreply,
        emailSource: "github",
        githubNoreply: noreply,
        githubLogin: "matteo",
      },
    });
    const privateChoice = await screen.findByRole("radio", { name: /Use my private GitHub address/ });
    expect(privateChoice.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText(noreply)).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Email" })).toBeNull();
    // 1.175.0 F1: with GitHub before Git the address comes from there, and
    // the step says so.
    const FROM_GITHUB = "From your GitHub account. It keeps your real address private.";
    expect(screen.getByText(FROM_GITHUB)).toBeTruthy();

    await user.click(screen.getByRole("radio", { name: /Use another email/ }));
    expect(field("Email").value).toBe("");
    expect(screen.queryByText(FROM_GITHUB)).toBeNull();
    await user.click(screen.getByRole("radio", { name: /Use my private GitHub address/ }));

    await user.click(footerButton("Save to Git"));
    const sheet = screen.getByRole("dialog", { name: "Set your Git name and email?" });
    await user.click(within(sheet).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(stub.callsOf("setup_identity_write")).toHaveLength(1));
    expect(stub.callsOf("setup_identity_write")[0].args).toEqual({ name: "Matteo B", email: noreply });
  });

  it("already set: Git knows you, Continue; Change opens the fields with what Git has", async () => {
    const { user, tauri: stub } = await openGit({ gitIdentity: identity("Matteo", "m@example.com") });
    expect(screen.getByText("Git knows you as Matteo <m@example.com>.")).toBeTruthy();
    expect(footerButton("Continue")).toBeTruthy();
    // Nothing to prefill while it's set.
    expect(stub.callsOf("setup_identity_prefill")).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Change" }));
    expect(field("Name").value).toBe("Matteo");
    expect(field("Email").value).toBe("m@example.com");
    expect(footerButton("Save to Git")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Keep what Git has" }));
    expect(screen.getByText("Git knows you as Matteo <m@example.com>.")).toBeTruthy();
  });

  it("a refused write stays in the sheet with Git's words", async () => {
    const { user } = await openGit({
      prefill: { ...NO_PREFILL, name: "Matteo", email: "m@example.com", nameSource: "git", emailSource: "git" },
      fixtures: {
        setup_identity_write: () => {
          throw "Git didn't save your name: error: could not lock config file";
        },
      },
    });
    await waitFor(() => expect(field("Email").value).toBe("m@example.com"));
    await user.click(footerButton("Save to Git"));
    const sheet = screen.getByRole("dialog", { name: "Set your Git name and email?" });
    await user.click(within(sheet).getByRole("button", { name: "Save" }));
    expect(await within(sheet).findByText(/could not lock config file/)).toBeTruthy();
  });
});

describe("Setup step 4, review fixes", () => {
  it("P2-1: a prefill landing after the person typed never replaces their email, even with the sheet open", async () => {
    const noreply = "1234567+matteo@users.noreply.github.com";
    let answer: (p: IdentityPrefill) => void = () => {};
    const late = new Promise<IdentityPrefill>((resolve) => {
      answer = resolve;
    });
    const { user, tauri: stub } = await openGit({ fixtures: { setup_identity_prefill: () => late } });
    await user.type(field("Name"), "Typed Name");
    await user.type(field("Email"), "typed@example.com");
    await user.click(footerButton("Save to Git"));
    const sheet = screen.getByRole("dialog", { name: "Set your Git name and email?" });
    // gh answers now, with a private email.
    await act(async () => {
      answer({
        name: "GH Name",
        nameSource: "github",
        email: noreply,
        emailSource: "github",
        githubNoreply: noreply,
        githubLogin: "matteo",
      });
      await late;
    });
    expect(sheet.textContent).toContain('git config --global user.email "typed@example.com"');
    expect(sheet.textContent).not.toContain(noreply);
    await user.click(within(sheet).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(stub.callsOf("setup_identity_write")).toHaveLength(1));
    expect(stub.callsOf("setup_identity_write")[0].args).toEqual({ name: "Typed Name", email: "typed@example.com" });
  });

  it("P2-1: after the sheet closes, the private address is offered but not chosen", async () => {
    const noreply = "1234567+matteo@users.noreply.github.com";
    let answer: (p: IdentityPrefill) => void = () => {};
    const late = new Promise<IdentityPrefill>((resolve) => {
      answer = resolve;
    });
    const { user } = await openGit({ fixtures: { setup_identity_prefill: () => late } });
    await user.type(field("Email"), "typed@example.com");
    await act(async () => {
      answer({ ...NO_PREFILL, email: noreply, emailSource: "github", githubNoreply: noreply, githubLogin: "matteo" });
      await late;
    });
    expect(screen.getByRole("radio", { name: /Use another email/ }).getAttribute("aria-checked")).toBe("true");
    expect(field("Email").value).toBe("typed@example.com");
  });

  it("P3-1: no prefill while Git doesn't work", async () => {
    const { tauri: stub } = await openGit({ tools: [gitNoClt] });
    await nextFrame();
    expect(stub.callsOf("setup_identity_prefill")).toEqual([]);
  });

  it("P3-2: the sheet names this PC on Windows", async () => {
    setPlatformForTests("windows");
    const { user } = await openGit({
      tools: [
        { id: "git", found: true, versionOk: true, installCmd: WINGET },
        { id: "git-bash", found: true, versionOk: true },
      ],
      prefill: { ...NO_PREFILL, name: "M", email: "m@example.com", nameSource: "git", emailSource: "git" },
    });
    await waitFor(() => expect(field("Email").value).toBe("m@example.com"));
    await user.click(footerButton("Save to Git"));
    const sheet = screen.getByRole("dialog", { name: "Set your Git name and email?" });
    expect(sheet.textContent).toContain("Every Git project on this PC uses these unless it sets its own.");
  });
});

// 1.175.0 F1: on a computer without Git, the GitHub step's one sheet was
// agreed to with its third thing ("Lets Git use that sign-in") left for this
// step. Once Git answers it is done here — no sheet, once — and the step
// says so. Without that yes, or without an account signed in, nothing runs.
describe("F1: Git's part of Connect GitHub, done in the Git step", () => {
  const HELPER_RUN: SetupStarted = {
    runId: "run-helper",
    actionId: "setupgit.gh",
    ptyId: "pty-helper",
    display: "gh auth setup-git --hostname github.com",
    watch: { kind: "answer" },
  };
  const gh = { id: "gh", found: true, versionOk: true, version: "2.62.0" };
  const status = (over: Record<string, unknown>) => ({
    ghFound: true,
    accounts: [{ login: "octocat", active: true, state: "signed-in", scopes: "repo, read:org" }],
    helper: "none",
    githubEmail: null,
    githubNoreply: null,
    sso: null,
    ...over,
  });
  const run = () => {
    tauri().emit("setup://progress", progress(HELPER_RUN, {}));
    return HELPER_RUN;
  };
  const kept = (stub: ReturnType<typeof tauri>) =>
    stub.callsOf("settings_set").map((c) => (c.args.settings as Settings).onboarding.gitHelperConsented ?? false);

  it("with the yes: setup-git runs by itself, once, the yes is used up, and the step says it", async () => {
    const { tauri: stub } = await openGit({
      tools: [gitOk, { id: "claude", found: true, versionOk: true }, gh],
      gitIdentity: identity("Octo Cat", "octo@example.com"),
      gitHelperConsented: true,
      fixtures: { setup_github_status: () => status({}), setup_run: run, setup_reach: { reachable: true, proxy: false, details: null } },
    });
    await waitFor(() => expect(stub.callsOf("setup_run").map((c) => c.args.actionId)).toEqual(["setupgit.gh"]));
    // No sheet asked anything.
    expect(screen.queryByRole("dialog", { name: /\?$/ })).toBeNull();
    await waitFor(() => expect(kept(stub)).toContain(false));
    expect(useSettings.getState().settings.onboarding.gitHelperConsented).toBe(false);
    act(() => tauri().emit("setup://progress", progress(HELPER_RUN, { phase: "done", outcome: "succeeded", exitCode: 0 })));
    expect(await screen.findByText("Git now uses your GitHub sign-in.")).toBeTruthy();
    await nextFrame();
    expect(stub.callsOf("setup_run")).toHaveLength(1);
  });

  it("without the yes nothing runs, and GitHub isn't even read", async () => {
    const { tauri: stub } = await openGit({
      tools: [gitOk, { id: "claude", found: true, versionOk: true }, gh],
      gitIdentity: identity("Octo Cat", "octo@example.com"),
      fixtures: { setup_github_status: () => status({}), setup_run: run },
    });
    await nextFrame();
    await nextFrame();
    expect(stub.callsOf("setup_run")).toEqual([]);
    expect(stub.callsOf("setup_github_status").filter((c) => c.args.details === true)).toEqual([]);
    expect(screen.queryByText("Git now uses your GitHub sign-in.")).toBeNull();
  });

  it("the yes, but no account signed in (the sign-in was stopped): nothing runs, and the yes goes", async () => {
    const { tauri: stub } = await openGit({
      tools: [gitOk, { id: "claude", found: true, versionOk: true }, gh],
      gitIdentity: identity("Octo Cat", "octo@example.com"),
      gitHelperConsented: true,
      fixtures: { setup_github_status: () => status({ accounts: [] }), setup_run: run },
    });
    await waitFor(() => expect(kept(stub)).toContain(false));
    await nextFrame();
    expect(stub.callsOf("setup_run")).toEqual([]);
  });

  it("the yes, and Git already uses the sign-in: nothing runs", async () => {
    const { tauri: stub } = await openGit({
      tools: [gitOk, { id: "claude", found: true, versionOk: true }, gh],
      gitIdentity: identity("Octo Cat", "octo@example.com"),
      gitHelperConsented: true,
      fixtures: { setup_github_status: () => status({ helper: "gh" }), setup_run: run },
    });
    await waitFor(() => expect(kept(stub)).toContain(false));
    await nextFrame();
    expect(stub.callsOf("setup_run")).toEqual([]);
  });

  it("the yes waits while Git isn't installed", async () => {
    const { tauri: stub } = await openGit({
      tools: [gitNoClt, gh],
      gitHelperConsented: true,
      fixtures: { setup_github_status: () => status({ helper: "unknown" }), setup_run: run },
    });
    await nextFrame();
    await nextFrame();
    expect(stub.callsOf("setup_run")).toEqual([]);
    expect(useSettings.getState().settings.onboarding.gitHelperConsented).toBe(true);
  });
});

describe("the ways into step 4", () => {
  it("First project says Git needs a name and email, and goes back to step 4", async () => {
    const { user } = await openGit({ gitIdentity: identity(null, null) });
    act(() => useSetup.getState().openSetup("rerun", "project"));
    await waitFor(() => expect(document.querySelector(".ux-setup-steptitle")?.textContent).toBe("Your first project"));
    expect(screen.getByText("Git needs your name and email before Plyloft can make the first commit.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Go to Git and your name" }));
    expect(document.querySelector(".ux-setup-steptitle")?.textContent).toBe("Git and your name");
  });

  it("Profile (C4): Setup writes the identity now, and Change opens step 4", async () => {
    act(() =>
      useSettings.setState({
        settings: { ...DEFAULT_SETTINGS, identity: { userEmail: "m@example.com" } },
        loaded: true,
      }),
    );
    const { user } = renderUi(<ProfilePage scope="this-mac" />, { fixtures: { "plugin:app|version": "1.152.1" } });
    expect(
      screen.getByText("Read from your git configuration. Setup's Git and your name step changes it, and asks before it saves."),
    ).toBeTruthy();
    expect(screen.queryByText(/never writes/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Change" }));
    expect(useSetup.getState().open).toBe(true);
    expect(useSetup.getState().step).toBe("git");
  });
});
