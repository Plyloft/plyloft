// OB-7a (ONBOARDING_SPEC §5 step 5), reshaped by 1.175.0 F1 (UX-2): Setup's
// "GitHub for your projects" step, rendered inside Setup. Three rows with no
// button of their own and one footer button, Connect GitHub → **one** sheet
// naming what is missing (install, sign-in, Git using the sign-in) → the
// runner, its terminal closed under Details, gh's one-time code big with the
// button that opens github.com; Git's part after the sign-in, only when Git
// still needs it (GCM on Windows), or kept for the Git step when Git isn't
// installed; an expired code and a stopped sign-in said in words; several
// accounts and Add another account; the scope fix; the SSO message; the
// identity back-fill (Setup opened again from Settings); Skip in solo and in
// team mode; the fast checklist's row. And OB-5's leave guard.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SetupOverlay } from "../components/SetupOverlay";
import { useSetup } from "../store/setupStore";
import { useToasts } from "../store/toastStore";
import { useWorkspaces } from "../store/workspaceStore";
import { DEFAULT_SETTINGS, useSettings, type Settings } from "../store/settingsStore";
import { setPlatformForTests } from "../lib/platform";
import type { GithubAccount, GithubStatus, SetupProgressEvent, SetupStarted, GitIdentityStatus } from "../ipc";
import type { SetupStepId } from "../lib/settingsShape";
import { act, nextFrame, renderUi, screen, waitFor, within } from "./render";
import { tauri } from "./tauri";

// QoL 1.168 (D6): the Your AI step's notification row reads the permission.
beforeEach(() => tauri().fixture("notification_access", "allowed"));

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

// ── The machine ──────────────────────────────────────────────────────────

const ZIP =
  "v=$(curl -fsSI https://github.com/cli/cli/releases/latest | grep -i '^location:' | sed 's#.*/tag/v##' | tr -d '\\r\\n') && … ~/.local/bin/gh --version";
const WINGET_GH =
  "winget install --id GitHub.cli -e --source winget --scope user --accept-package-agreements --accept-source-agreements";

type Tool = {
  id: string;
  found: boolean;
  versionOk: boolean;
  version?: string | null;
  installCmd?: string;
  update?: { latest: string; detail: string; command: string } | null;
};
const git: Tool = { id: "git", found: true, versionOk: true, version: "2.39.5", installCmd: "xcode-select --install" };
const claude: Tool = { id: "claude", found: true, versionOk: true, installCmd: "curl" };
const gh = (found: boolean, over: Partial<Tool> = {}): Tool => ({
  id: "gh",
  found,
  versionOk: found,
  version: found ? "2.101.0" : null,
  installCmd: ZIP,
  ...over,
});

const acct = (login: string, over: Partial<GithubAccount> = {}): GithubAccount => ({
  login,
  active: false,
  state: "signed-in",
  scopes: "gist, read:org, repo, workflow",
  ...over,
});
const NONE: GithubStatus = {
  ghFound: true,
  accounts: [],
  helper: "none",
  githubEmail: null,
  githubNoreply: null,
  sso: null,
};

const identity = (name: string | null, email: string | null): GitIdentityStatus => ({
  name,
  email,
  set: Boolean(name && email),
  detail: "",
});

/** What the doctor and gh say now; a test changes them as a run would. */
let tools: Tool[] = [];
let github: GithubStatus = NONE;

function started(actionId: SetupStarted["actionId"], n: number): SetupStarted {
  return { runId: `run-${actionId}-${n}`, actionId, ptyId: `pty-${actionId}-${n}`, display: actionId, watch: { kind: "answer" } };
}
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
const bytes = (text: string) => Array.from(new TextEncoder().encode(text));

interface Opts {
  tools?: Tool[];
  github?: GithubStatus;
  settings?: Partial<Settings>;
  step?: SetupStepId;
  gitIdentity?: GitIdentityStatus | null;
  /** Replaces the step's read (a slow gh, say). */
  statusFixture?: (args: Record<string, unknown>) => unknown;
  /** What each run prints as it starts. */
  prints?: Partial<Record<SetupStarted["actionId"], string>>;
  /** F16c: the account the opener asks to sign in. */
  githubAccount?: string;
}

async function openStep(o: Opts = {}) {
  tools = o.tools ?? [git, claude, gh(true)];
  github = o.github ?? NONE;
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    ...o.settings,
    onboarding: { ...DEFAULT_SETTINGS.onboarding, level: "guided", ...o.settings?.onboarding },
  };
  let n = 0;
  const runs: SetupStarted[] = [];
  act(() => {
    useSettings.setState({ settings, loaded: true });
    useWorkspaces.setState({ workspaces: [], activeId: null });
  });
  const r = renderUi(<SetupOverlay />, {
    fixtures: {
      settings_set: ({ settings: next }: Record<string, unknown>) => next,
      dependency_doctor: () => ({
        tools,
        allRequiredOk: true,
        gitIdentity: o.gitIdentity ?? identity("Matteo", "matteo@example.com"),
        whisperModel: { model: "small", present: false, path: null, detail: "Not downloaded." },
      }),
      shell_env_info: {},
      shell_env_retry: {},
      team_work_mode: { mode: settings.team?.workMode ?? "solo", chosen: true },
      team_status: { teamRepo: null, teamName: null, hasClone: false },
      project_config_list: [],
      build_cache_status: null,
      setup_identity_prefill: { name: "", nameSource: "none", email: "", emailSource: "none", githubNoreply: null, githubLogin: null },
      setup_check: { signedIn: true, method: "claude.ai", plan: "max", words: null },
      claude_review_trust_status: { folder: "/cfg/claude-sessions", trusted: true },
      // Only the step's own read asks GitHub for the address and meets SSO.
      setup_github_status:
        o.statusFixture ??
        (({ details }: Record<string, unknown>) =>
          details ? github : { ...github, githubEmail: null, githubNoreply: null, sso: null }),
      setup_reach: { reachable: true, proxy: false, details: null },
      setup_run: ({ actionId }: Record<string, unknown>) => {
        const run = started(actionId as SetupStarted["actionId"], ++n);
        runs.push(run);
        tauri().emit("setup://progress", progress(run, {}));
        const out = o.prints?.[run.actionId];
        if (out) tauri().emit("pty://data", { id: run.ptyId, data: bytes(out) });
        return run;
      },
      setup_stop: true,
      setup_active: null,
      setup_open_page: null,
      setup_open_github_sso: null,
      setup_identity_write: ({ name, email }: Record<string, unknown>) => ({ name, email }),
      // OB-12: Skip lands on step 7, which looks at the projects folder.
      projects_folder_look: { path: "/Users/me/Projects", exists: false, notAFolder: false, projects: 0 },
      pty_resize: null,
      // F1: the code's button gives the GitHub command its Enter.
      pty_write: null,
    },
  });
  act(() => useSetup.getState().openSetup("rerun", o.step ?? "github", { githubAccount: o.githubAccount }));
  await nextFrame();
  const titles: Partial<Record<SetupStepId, string>> = { github: TITLE, git: "Git and your name", ai: "Your AI" };
  const want = titles[o.step ?? "github"];
  if (want) await waitFor(() => expect(stepTitle()).toBe(want));
  return { ...r, runs };
}

const TITLE = "Connect GitHub for your projects";
const LIST_NAME = "GitHub for your projects";
const stepTitle = () => document.querySelector(".ux-setup-steptitle")?.textContent;
const footer = () => document.querySelector(".ux-setup-foot") as HTMLElement;
const footerButton = (name: string) => within(footer()).getByRole("button", { name });
const rowOf = (label: string) => screen.getByText(label, { selector: ".ux-row-label, .ux-row-label *" }).closest(".ux-row") as HTMLElement;
const stepList = () => screen.getByRole("navigation", { name: "Setup steps" });
const runsOf = () => tauri().callsOf("setup_run").map((c) => c.args.actionId);
const emit = (run: SetupStarted, over: Partial<SetupProgressEvent>) =>
  act(() => tauri().emit("setup://progress", progress(run, over)));

// ── F1: the first time ───────────────────────────────────────────────────

const CODE = "! First copy your one-time code: 4F2A-9C1B\nPress Enter to open github.com in your browser...";
const rowWords = () =>
  Array.from(document.querySelectorAll<HTMLElement>(".ux-setup-content .ux-group .ux-row")).map((row) =>
    row.querySelector(".ux-row-label")?.textContent,
  );
const partsOf = (sheet: HTMLElement) =>
  Array.from(sheet.querySelectorAll("[data-ply-connect-part]")).map((li) => li.getAttribute("data-ply-connect-part"));
const signedIn = [acct("test-owner", { active: true })];

describe("F1: one press, one sheet", () => {
  it("nothing there yet: three rows with no button, Connect GitHub → the one sheet → install, sign in, Git's part", async () => {
    const { user, runs } = await openStep({
      tools: [git, claude, gh(false)],
      github: { ...NONE, ghFound: false, accounts: null },
      prints: { "login.gh": CODE },
    });
    const dialog = screen.getByRole("dialog", { name: "Setup" });
    // The title says it is a second sign-in; the sentence says why.
    expect(dialog.textContent).toContain(
      "This lets this Mac send your work to GitHub: Ship it puts each finished card there as a pull request. It is not your Plyloft account. GitHub shows you a code. It takes about a minute.",
    );
    expect(dialog.textContent).toContain("If you skip it, Ship it will keep your changes on this Mac.");
    expect(screen.getByRole("button", { name: "Skip for now" }).getAttribute("title")).toBe("Ship it will keep your changes on this Mac.");
    expect(dialog.textContent).not.toContain("Your team needs GitHub.");
    // What Connect GitHub does: the plan, row by row, with nothing to press.
    expect(screen.getByText("What Connect GitHub does")).toBeTruthy();
    expect(rowWords()).toEqual(["Installs the GitHub command", "Signs it in as you", "Lets Git use that sign-in"]);
    expect(rowOf("Installs the GitHub command").textContent).toContain("Not installed. It is how Plyloft talks to GitHub.");
    // 1.176.4: what Connect GitHub downloads, and from where.
    expect(dialog.textContent).toContain("Connect GitHub downloads the GitHub command from GitHub, checks it against GitHub's published checksum");
    expect(rowOf("Signs it in as you").textContent).toContain("Your browser opens github.com, where you type a code Plyloft shows.");
    expect(rowOf("Lets Git use that sign-in").textContent).toContain("So sending your work to GitHub never asks for a password.");
    const group = rowOf("Signs it in as you").closest(".ux-group") as HTMLElement;
    expect(within(group).queryAllByRole("button")).toEqual([]);
    expect(screen.queryByRole("button", { name: "I don't have an account" })).toBeNull();
    expect(screen.queryByText("Your commit email")).toBeNull();

    await user.click(footerButton("Connect GitHub"));
    const sheet = screen.getByRole("dialog", { name: "Connect GitHub on this Mac?" });
    expect(sheet.textContent).toContain("Plyloft does these three things, one after the other. Nothing else changes.");
    expect(partsOf(sheet)).toEqual(["install", "signin", "helper"]);
    expect(sheet.textContent).toContain("checks it against GitHub's published checksum and puts it in ~/.local/bin. No administrator needed.");
    expect(sheet.textContent).toContain("Your browser opens github.com/login/device. You type the code Plyloft shows and approve.");
    expect(sheet.textContent).toContain("Git on this Mac asks the GitHub command for your password, so sending your work never asks you.");
    expect(sheet.textContent).toContain("Plyloft never stores or shows it, and never gives it to the agents' terminals.");
    // Every command it will run is under Details, and the focus is on Cancel.
    const commands = sheet.querySelector(".ux-output")?.textContent ?? "";
    expect(commands).toContain(ZIP);
    expect(commands).toContain("gh auth login --hostname github.com --git-protocol https --web --skip-ssh-key");
    expect(commands).toContain("gh auth setup-git --hostname github.com");
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Cancel"));
    // Nothing runs before the press.
    expect(runsOf()).toEqual([]);
    await user.click(within(sheet).getByRole("button", { name: "Connect GitHub" }));

    await waitFor(() => expect(runsOf()).toEqual(["install.gh"]));
    // Only the action id crosses; the host was checked first.
    expect(tauri().callsOf("setup_run")[0].args).toEqual({ actionId: "install.gh", args: null, cols: null, rows: null });
    expect(tauri().callsOf("setup_reach")[0].args).toEqual({ actionId: "install.gh" });
    expect(await screen.findByText("Installing the GitHub command…")).toBeTruthy();
    expect(rowWords()).toEqual(["GitHub command", "Account", "Git uses your GitHub sign-in"]);
    expect(within(rowOf("GitHub command")).getByText("Installing")).toBeTruthy();
    expect(within(rowOf("Account")).getByText("Next")).toBeTruthy();
    expect(within(rowOf("Git uses your GitHub sign-in")).getByText("Next")).toBeTruthy();
    // While it runs the footer has no filled button, and Stop is the run's.
    expect(Array.from(footer().querySelectorAll(".cbtn--accent"))).toEqual([]);
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    // The run's terminal is there, closed under Details.
    const pane = document.querySelector("[data-ply-setup-pty-id]") as HTMLElement;
    expect((pane.closest("details") as HTMLDetailsElement).open).toBe(false);

    // Installed: the doctor re-reads, and the sign-in follows by itself.
    tools = [git, claude, gh(true)];
    github = NONE;
    emit(runs[0], { phase: "done", outcome: "succeeded", exitCode: 0, reprobed: true });
    await waitFor(() => expect(runsOf()).toEqual(["install.gh", "login.gh"]));
    expect(await screen.findByText("Waiting for you to approve on GitHub…")).toBeTruthy();
    await waitFor(() => expect(screen.getByLabelText("One-time code").textContent).toBe("4F2A-9C1B"));
    expect(screen.getByText("Enter this code on github.com/login/device and approve.")).toBeTruthy();
    await waitFor(() => expect(within(rowOf("Account")).getByText("Signing in")).toBeTruthy());
    // The code in its own block, outside the terminal; the page's button is
    // the step's one filled button.
    const codeBlock = screen.getByLabelText("One-time code").closest(".ux-signin-code") as HTMLElement;
    expect(codeBlock.closest("details")).toBeNull();
    expect(within(codeBlock).getByRole("button", { name: "Copy code" })).toBeTruthy();
    expect(Array.from(dialog.querySelectorAll(".cbtn--accent")).map((b) => b.textContent)).toEqual([
      "Open github.com/login/device",
    ]);
    // Its first press gives the GitHub command the Enter it waits for.
    await user.click(screen.getByRole("button", { name: "Open github.com/login/device" }));
    await waitFor(() => expect(tauri().callsOf("pty_write")).toHaveLength(1));

    // Signed in. Plyloft reads again, Git still doesn't use the sign-in, and
    // Git's part runs — agreed to in the sheet, so with no second question.
    github = { ...NONE, accounts: signedIn, helper: "none" };
    emit(runs[1], { phase: "done", outcome: "succeeded", exitCode: 0 });
    await waitFor(() => expect(runsOf()).toEqual(["install.gh", "login.gh", "setupgit.gh"]));
    expect(screen.queryByRole("dialog", { name: /\?$/ })).toBeNull();
    github = { ...NONE, accounts: signedIn, helper: "gh" };
    emit(runs[2], { phase: "done", outcome: "succeeded", exitCode: 0 });
    await waitFor(() => expect(within(rowOf("Git uses your GitHub sign-in")).getByText("Ready")).toBeTruthy());
    expect(within(rowOf("Account")).getByText("Signed in as test-owner.")).toBeTruthy();
    expect(await screen.findByText("GitHub is connected on this Mac.")).toBeTruthy();
    await waitFor(() => expect(footerButton("Continue")).toBeTruthy());
    await waitFor(() =>
      expect(within(stepList()).getByRole("button", { name: /GitHub for your projects/ }).textContent).toContain("Done"),
    );
    // Once, and nothing after it.
    await nextFrame();
    expect(runsOf()).toEqual(["install.gh", "login.gh", "setupgit.gh"]);
    // The yes was never kept in the file: Git was there.
    expect(
      tauri().callsOf("settings_set").some((c) => (c.args.settings as Settings).onboarding.gitHelperConsented === true),
    ).toBe(false);
  });

  it("the command is there: the sheet names two things; with Homebrew and on Windows it says how it installs", async () => {
    const { user, unmount } = await openStep({ github: { ...NONE, helper: "none" } });
    await waitFor(() => expect(rowWords()).toEqual(["GitHub command", "Signs it in as you", "Lets Git use that sign-in"]));
    expect(within(rowOf("GitHub command")).getByText("Ready")).toBeTruthy();
    await user.click(footerButton("Connect GitHub"));
    const two = screen.getByRole("dialog", { name: "Connect GitHub on this Mac?" });
    expect(two.textContent).toContain("Plyloft does these two things, one after the other. Nothing else changes.");
    expect(partsOf(two)).toEqual(["signin", "helper"]);
    await user.click(within(two).getByRole("button", { name: "Cancel" }));
    expect(runsOf()).toEqual([]);
    unmount();
    act(() => useSetup.setState({ open: false, step: null }));

    const brew = await openStep({
      tools: [git, claude, gh(false, { installCmd: "brew install gh" })],
      github: { ...NONE, ghFound: false, accounts: null },
    });
    await brew.user.click(footerButton("Connect GitHub"));
    const mac = screen.getByRole("dialog", { name: "Connect GitHub on this Mac?" });
    expect(mac.textContent).toContain("With Homebrew. On a Mac without Homebrew, Plyloft downloads it from GitHub");
    expect(mac.querySelector(".ux-output")?.textContent).toContain("brew install gh");
    brew.unmount();
    act(() => useSetup.setState({ open: false, step: null }));

    setPlatformForTests("windows");
    const w = await openStep({
      tools: [git, { id: "git-bash", found: true, versionOk: true }, claude, gh(false, { installCmd: WINGET_GH })],
      github: { ...NONE, ghFound: false, accounts: null },
    });
    await w.user.click(footerButton("Connect GitHub"));
    const win = screen.getByRole("dialog", { name: "Connect GitHub on this PC?" });
    expect(win.textContent).toContain("With winget, Windows' package installer, for your account only. No administrator needed.");
    expect(win.textContent).toContain("Git on this PC asks the GitHub command for your password");
    expect(win.querySelector(".ux-output")?.textContent).toContain(WINGET_GH);
  });

  it("only the sign-in is missing: it starts at once, with no sheet", async () => {
    const { user } = await openStep({ github: { ...NONE, helper: "gh" } });
    await waitFor(() => expect(within(rowOf("Git uses your GitHub sign-in")).getByText("Ready")).toBeTruthy());
    await user.click(footerButton("Connect GitHub"));
    await waitFor(() => expect(runsOf()).toEqual(["login.gh"]));
    expect(screen.queryByRole("dialog", { name: /\?$/ })).toBeNull();
  });

  it("a newer gh is offered with a quiet Update, confirmed first", async () => {
    const { user } = await openStep({
      tools: [git, claude, gh(true, { update: { latest: "2.102.0", detail: "Version 2.102.0 is available.", command: "brew upgrade gh" } })],
    });
    await user.click(within(rowOf("GitHub command")).getByRole("button", { name: "Update" }));
    const sheet = screen.getByRole("dialog", { name: "Update the GitHub command?" });
    expect(within(sheet).getByText("brew upgrade gh")).toBeTruthy();
    await user.click(within(sheet).getByRole("button", { name: "Update" }));
    await waitFor(() => expect(runsOf()).toEqual(["update.gh"]));
  });

  it("1.176.0 R2: a refused update keeps the old version and shows the block with its cause", async () => {
    const { user, runs } = await openStep({
      tools: [git, claude, gh(true, { update: { latest: "2.102.0", detail: "Version 2.102.0 is available.", command: "brew upgrade gh" } })],
    });
    await user.click(within(rowOf("GitHub command")).getByRole("button", { name: "Update" }));
    await user.click(within(screen.getByRole("dialog", { name: "Update the GitHub command?" })).getByRole("button", { name: "Update" }));
    await waitFor(() => expect(runs).toHaveLength(1));
    emit(runs[0], {
      phase: "done",
      outcome: "still-on-old-version",
      exitCode: 1,
      reprobed: true,
      tail: ["Error: Permission denied @ apply2files - /opt/homebrew/Cellar/gh"],
      cause: "permissions",
      causePath: "/opt/homebrew/Cellar",
      versionBefore: "2.101.0",
      versionAfter: "2.101.0",
    });
    expect((await screen.findAllByText("The GitHub command wasn't updated.")).length).toBeGreaterThan(0);
    expect(
      screen.getByText("The computer didn't let the GitHub command's updater change the folder /opt/homebrew/Cellar."),
    ).toBeTruthy();
    expect(screen.getByText("The GitHub command still works, on version 2.101.0.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Do it yourself" })).toBeTruthy();
  });
});

// ── F1: when it doesn't go through ───────────────────────────────────────

describe("F1: when it doesn't go through", () => {
  async function agreed(o: Opts) {
    const r = await openStep(o);
    await r.user.click(footerButton("Connect GitHub"));
    await r.user.click(within(screen.getByRole("dialog", { name: "Connect GitHub on this Mac?" })).getByRole("button", { name: "Connect GitHub" }));
    return r;
  }

  it("the installer fails: the error block, the rows say Not started, and Try again asks nothing again", async () => {
    const { user, runs } = await agreed({ tools: [git, claude, gh(false)], github: { ...NONE, ghFound: false, accounts: null } });
    await waitFor(() => expect(runs).toHaveLength(1));
    emit(runs[0], { phase: "done", outcome: "failed", exitCode: 6, tail: ["curl: (6) Could not resolve host: github.com"] });
    expect((await screen.findAllByText("The GitHub command wasn't installed.")).length).toBeGreaterThan(0);
    expect(
      screen.getByText("Try again, or install it yourself from the GitHub command's page: Plyloft sees it when it's there."),
    ).toBeTruthy();
    expect(screen.queryByText(/press Check again/)).toBeNull();
    expect(within(rowOf("Account")).getByText("Not started")).toBeTruthy();
    expect(within(rowOf("Git uses your GitHub sign-in")).getByText("Not started")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Do it yourself" }));
    expect(tauri().callsOf("setup_open_page").map((c) => c.args.page)).toEqual(["install-gh"]);
    // The footer's button is Try again: the same yes still stands.
    await user.click(footerButton("Try again"));
    await waitFor(() => expect(runsOf()).toEqual(["install.gh", "install.gh"]));
    expect(screen.queryByRole("dialog", { name: /\?$/ })).toBeNull();
  });

  it("the code expired: said in words, and Get a new code signs in again with no sheet", async () => {
    const { user, runs } = await agreed({ github: { ...NONE, helper: "none" }, prints: { "login.gh": CODE } });
    await waitFor(() => expect(runsOf()).toEqual(["login.gh"]));
    emit(runs[0], {
      phase: "done",
      outcome: "failed",
      exitCode: 1,
      tail: ["failed to authenticate via web browser: This 'device_code' has expired. (expired_token)"],
    });
    expect(await screen.findByText("That code expired before GitHub had your approval. Nothing was changed.")).toBeTruthy();
    expect(within(rowOf("Account")).getByText("Not signed in yet.")).toBeTruthy();
    expect(within(rowOf("Git uses your GitHub sign-in")).getByText("Not started")).toBeTruthy();
    await user.click(footerButton("Get a new code"));
    await waitFor(() => expect(runsOf()).toEqual(["login.gh", "login.gh"]));
    expect(screen.queryByRole("dialog", { name: /\?$/ })).toBeNull();
    // Git's part still follows the sign-in that works: once.
    github = { ...NONE, accounts: signedIn, helper: "none" };
    emit(runs[1], { phase: "done", outcome: "succeeded", exitCode: 0 });
    await waitFor(() => expect(runsOf()).toEqual(["login.gh", "login.gh", "setupgit.gh"]));
  });

  it("the person stops the sign-in: said in words, nothing of Git's part runs, and Connect GitHub asks again", async () => {
    const { user, runs, tauri: stub } = await agreed({ github: { ...NONE, helper: "none" }, prints: { "login.gh": CODE } });
    await waitFor(() => expect(runsOf()).toEqual(["login.gh"]));
    await user.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(stub.callsOf("setup_stop")).toHaveLength(1));
    emit(runs[0], { phase: "done", outcome: "cancelled", exitCode: null });
    expect(await screen.findByText("You stopped the sign-in. Nothing was changed.")).toBeTruthy();
    await nextFrame();
    expect(runsOf()).toEqual(["login.gh"]);
    // The yes went with it: the sheet is asked again.
    await user.click(footerButton("Connect GitHub"));
    expect(screen.getByRole("dialog", { name: "Connect GitHub on this Mac?" })).toBeTruthy();
    expect(runsOf()).toEqual(["login.gh"]);
  });

  it("Cancel on GitHub's page is the person's stop too", async () => {
    const { runs } = await agreed({ github: { ...NONE, helper: "none" } });
    await waitFor(() => expect(runsOf()).toEqual(["login.gh"]));
    emit(runs[0], {
      phase: "done",
      outcome: "failed",
      exitCode: 1,
      tail: ["failed to authenticate via web browser: The authorization request was denied. (access_denied)"],
    });
    expect(await screen.findByText("You stopped the sign-in. Nothing was changed.")).toBeTruthy();
    expect(footerButton("Connect GitHub")).toBeTruthy();
  });

  it("another failure of the sign-in: the run's own line, and Try again", async () => {
    const { runs } = await agreed({ github: { ...NONE, helper: "none" } });
    await waitFor(() => expect(runsOf()).toEqual(["login.gh"]));
    emit(runs[0], { phase: "done", outcome: "failed", exitCode: 1, tail: ["error connecting to github.com"] });
    expect(await screen.findByText("The GitHub command stopped with an error. Nothing was changed.")).toBeTruthy();
    expect(footerButton("Try again")).toBeTruthy();
  });
});

// ── F1: Git's part ───────────────────────────────────────────────────────

describe("F1: Git uses your GitHub sign-in", () => {
  it("connected, and Git doesn't use it yet: the step opens on that alone — today's sheet, then setup-git", async () => {
    const { user } = await openStep({ github: { ...NONE, accounts: signedIn, helper: "other" } });
    const row = await waitFor(() => rowOf("Git uses your GitHub sign-in"));
    expect(row.textContent).toContain("Git can push to GitHub with the same sign-in.");
    expect(within(row).queryAllByRole("button")).toEqual([]);
    await user.click(footerButton("Connect GitHub"));
    const sheet = screen.getByRole("dialog", { name: "Let Git use your GitHub sign-in?" });
    expect(sheet.textContent).toContain(
      "Plyloft will run gh auth setup-git, which tells Git on this Mac to ask the GitHub command for your password.",
    );
    expect(within(sheet).getByText("gh auth setup-git --hostname github.com")).toBeTruthy();
    expect(partsOf(sheet)).toEqual([]);
    expect(runsOf()).toEqual([]);
    await user.click(within(sheet).getByRole("button", { name: "Turn on" }));
    await waitFor(() => expect(runsOf()).toEqual(["setupgit.gh"]));
    expect(await screen.findByText("Letting Git use your GitHub sign-in…")).toBeTruthy();
    await nextFrame();
    expect(runsOf()).toEqual(["setupgit.gh"]);
  });

  for (const helper of ["gh", "unknown"] as const) {
    it(`nothing to do when git's helper is ${helper}: Continue`, async () => {
      await openStep({ github: { ...NONE, accounts: signedIn, helper } });
      await waitFor(() => expect(within(rowOf("Account")).getByText("Signed in as test-owner.")).toBeTruthy());
      expect(footerButton("Continue")).toBeTruthy();
      if (helper === "unknown") expect(screen.queryByText("Git uses your GitHub sign-in")).toBeNull();
      else expect(within(rowOf("Git uses your GitHub sign-in")).getByText("Ready")).toBeTruthy();
    });
  }

  // T5 (team walk, Windows): the git Plyloft runs can't show Git Credential
  // Manager's sign-in window, so GCM is offered the GitHub command's sign-in too.
  it("Git Credential Manager: offered, in its own words", async () => {
    await openStep({ github: { ...NONE, accounts: signedIn, helper: "gcm" } });
    await waitFor(() => expect(within(rowOf("Account")).getByText("Signed in as test-owner.")).toBeTruthy());
    expect(rowOf("Git uses your GitHub sign-in").textContent).toMatch(/Recommended\. Git Credential Manager keeps working for you/);
    expect(footerButton("Connect GitHub")).toBeTruthy();
  });

  // N14 item 7: Setup probes GCM with `git credential fill` (username only).
  it("Git Credential Manager signed in as the same account: nothing to do", async () => {
    await openStep({
      github: { ...NONE, accounts: signedIn, helper: "gcm", gcm: { state: "same", login: "test-owner" } },
    });
    await waitFor(() => expect(within(rowOf("Account")).getByText("Signed in as test-owner.")).toBeTruthy());
    expect(screen.queryByText("Git uses your GitHub sign-in")).toBeNull();
    expect(footerButton("Continue")).toBeTruthy();
  });

  it("Git Credential Manager with another account or nothing saved says so", async () => {
    const other = await openStep({
      github: { ...NONE, accounts: signedIn, helper: "gcm", gcm: { state: "other", login: "mb-work" } },
    });
    const row = await waitFor(() => rowOf("Git uses your GitHub sign-in"));
    expect(row.textContent).toContain(
      "Git Credential Manager is signed in to GitHub as mb-work. Turn this on so Plyloft's git uses test-owner, the account Setup uses.",
    );
    other.unmount();
    act(() => useSetup.setState({ open: false, step: null }));
    await openStep({ github: { ...NONE, accounts: signedIn, helper: "gcm", gcm: { state: "none", login: null } } });
    const none = await waitFor(() => rowOf("Git uses your GitHub sign-in"));
    expect(none.textContent).toContain("Git Credential Manager has no GitHub sign-in saved");
  });

  // After the sign-in Plyloft reads again: with Git Credential Manager
  // already answering for this account, Git's part is not run, though the
  // sheet named it.
  it("agreed to, and not needed after all: it doesn't run", async () => {
    const { user, runs } = await openStep({ github: { ...NONE, helper: "gcm" } });
    await user.click(footerButton("Connect GitHub"));
    const sheet = screen.getByRole("dialog", { name: "Connect GitHub on this Mac?" });
    expect(partsOf(sheet)).toEqual(["signin", "helper"]);
    await user.click(within(sheet).getByRole("button", { name: "Connect GitHub" }));
    await waitFor(() => expect(runsOf()).toEqual(["login.gh"]));
    github = { ...NONE, accounts: signedIn, helper: "gcm", gcm: { state: "same", login: "test-owner" } };
    emit(runs[0], { phase: "done", outcome: "succeeded", exitCode: 0 });
    await waitFor(() => expect(footerButton("Continue")).toBeTruthy());
    await nextFrame();
    expect(runsOf()).toEqual(["login.gh"]);
  });

  it("Windows: the sheet names this PC", async () => {
    setPlatformForTests("windows");
    const { user } = await openStep({
      tools: [git, { id: "git-bash", found: true, versionOk: true }, claude, gh(true, { installCmd: WINGET_GH })],
      github: { ...NONE, accounts: signedIn, helper: "other" },
    });
    await waitFor(() => rowOf("Git uses your GitHub sign-in"));
    await user.click(footerButton("Connect GitHub"));
    expect(screen.getByRole("dialog", { name: "Let Git use your GitHub sign-in?" }).textContent).toContain("Git on this PC");
  });

  // Git isn't installed yet (a Mac without the Command Line Tools): the
  // third thing is named with when it happens, the yes is kept in the
  // settings for the Git step, and nothing of it runs here.
  it("without Git: the row and the sheet say when, the yes is kept, and nothing of it runs here", async () => {
    const noGit: Tool = { ...git, found: false, versionOk: false };
    const { user, runs, tauri: stub } = await openStep({
      tools: [noGit, claude, gh(true)],
      github: { ...NONE, helper: "unknown" },
    });
    await waitFor(() => expect(rowOf("Lets Git use that sign-in").textContent).toMatch(/Once Git is installed, in step \d+\./));
    const said = rowOf("Lets Git use that sign-in").textContent!.match(/Once Git is installed, in step (\d+)\./)![1];
    // The number is the Git step's in the list on screen.
    const gitItem = within(stepList()).getByRole("button", { name: /Git and your name/ });
    expect(gitItem.textContent).toContain(said);
    await user.click(footerButton("Connect GitHub"));
    const sheet = screen.getByRole("dialog", { name: "Connect GitHub on this Mac?" });
    expect(partsOf(sheet)).toEqual(["signin", "helper"]);
    expect(sheet.textContent).toContain(`so sending your work never asks you. Once Git is installed, in step ${said}.`);
    const kept = () =>
      stub.callsOf("settings_set").map((c) => (c.args.settings as Settings).onboarding.gitHelperConsented ?? false);
    expect(kept()).not.toContain(true);
    await user.click(within(sheet).getByRole("button", { name: "Connect GitHub" }));
    await waitFor(() => expect(runsOf()).toEqual(["login.gh"]));
    // F1 round 2: not kept at the press — only once the sign-in succeeds.
    await nextFrame();
    expect(kept()).not.toContain(true);
    github = { ...NONE, accounts: signedIn, helper: "unknown" };
    emit(runs[0], { phase: "done", outcome: "succeeded", exitCode: 0 });
    await waitFor(() => expect(kept()).toContain(true));
    await waitFor(() => expect(footerButton("Continue")).toBeTruthy());
    await nextFrame();
    expect(runsOf()).toEqual(["login.gh"]);
    expect(rowOf("Git uses your GitHub sign-in").textContent).toContain(`Once Git is installed, in step ${said}.`);
  });

  // F1 round 2: any end but a sign-in that succeeded keeps nothing.
  const endings: [string, Partial<SetupProgressEvent>][] = [
    ["stopped", { outcome: "cancelled", exitCode: null }],
    ["expired", { outcome: "failed", exitCode: 1, tail: ["error: expired_token"] }],
    ["failed", { outcome: "failed", exitCode: 1, tail: ["something went wrong"] }],
  ];
  for (const [how, ending] of endings) {
    it(`without Git, a sign-in that ${how === "failed" ? "fails" : `is ${how}`}: no yes is kept`, async () => {
      const noGit: Tool = { ...git, found: false, versionOk: false };
      const { user, runs, tauri: stub } = await openStep({ tools: [noGit, claude, gh(true)], github: { ...NONE, helper: "unknown" } });
      await waitFor(() => rowOf("Lets Git use that sign-in"));
      await user.click(footerButton("Connect GitHub"));
      await user.click(within(screen.getByRole("dialog", { name: "Connect GitHub on this Mac?" })).getByRole("button", { name: "Connect GitHub" }));
      await waitFor(() => expect(runsOf()).toEqual(["login.gh"]));
      emit(runs[0], { phase: "done", ...ending });
      await nextFrame();
      await nextFrame();
      expect(
        stub.callsOf("settings_set").some((c) => (c.args.settings as Settings).onboarding.gitHelperConsented === true),
      ).toBe(false);
      expect(stub.callsOf("setup_run").map((c) => c.args.actionId)).toEqual(["login.gh"]);
    });
  }

  it("without Git, Setup closed while the sign-in waits: no yes is kept", async () => {
    const noGit: Tool = { ...git, found: false, versionOk: false };
    const { user, unmount, tauri: stub } = await openStep({ tools: [noGit, claude, gh(true)], github: { ...NONE, helper: "unknown" } });
    await waitFor(() => rowOf("Lets Git use that sign-in"));
    await user.click(footerButton("Connect GitHub"));
    await user.click(within(screen.getByRole("dialog", { name: "Connect GitHub on this Mac?" })).getByRole("button", { name: "Connect GitHub" }));
    await waitFor(() => expect(runsOf()).toEqual(["login.gh"]));
    unmount();
    expect(
      stub.callsOf("settings_set").some((c) => (c.args.settings as Settings).onboarding.gitHelperConsented === true),
    ).toBe(false);
  });

  // F1 round 2: already signed in and no Git — Git's part is offered, its
  // yes kept at the press, and nothing runs here.
  it("already connected, no Git: Git's part is offered for later, kept at the press, nothing runs", async () => {
    const noGit: Tool = { ...git, found: false, versionOk: false };
    const { user, tauri: stub } = await openStep({ tools: [noGit, claude, gh(true)], github: { ...NONE, accounts: signedIn, helper: "unknown" } });
    await waitFor(() => expect(rowOf("Git uses your GitHub sign-in").textContent).toMatch(/Once Git is installed, in step \d+\./));
    await user.click(footerButton("Connect GitHub"));
    const sheet = screen.getByRole("dialog", { name: "Let Git use your GitHub sign-in?" });
    expect(sheet.textContent).toMatch(/for your password\. Once Git is installed, in step \d+\./);
    await user.click(within(sheet).getByRole("button", { name: "Turn on" }));
    await waitFor(() => expect(useSettings.getState().settings.onboarding.gitHelperConsented).toBe(true));
    await waitFor(() => expect(footerButton("Continue")).toBeTruthy());
    expect(stub.callsOf("setup_run")).toEqual([]);
  });

  // F1 round 2: Try again runs only what the yes covered; something new is
  // asked for first.
  it("Try again after a failed sign-in: what wasn't agreed to opens the sheet, nothing runs", async () => {
    const { user, runs, tauri: stub } = await openStep({ github: { ...NONE, helper: "gh" } });
    await waitFor(() => expect(rowWords()).toEqual(["GitHub command", "Signs it in as you", "Git uses your GitHub sign-in"]));
    // A sign-in alone starts at once.
    await user.click(footerButton("Connect GitHub"));
    await waitFor(() => expect(runsOf()).toEqual(["login.gh"]));
    // It fails, and Git no longer asks the GitHub command: Git's part is new.
    github = { ...NONE, helper: "none" };
    emit(runs[0], { phase: "done", outcome: "failed", exitCode: 1, tail: ["something went wrong"] });
    await waitFor(() => expect(footerButton("Connect GitHub")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    await user.click(footerButton("Connect GitHub"));
    const sheet = await screen.findByRole("dialog", { name: "Connect GitHub on this Mac?" });
    expect(partsOf(sheet)).toEqual(["signin", "helper"]);
    expect(stub.callsOf("setup_run").map((c) => c.args.actionId)).toEqual(["login.gh"]);
  });
});

// ── Accounts ─────────────────────────────────────────────────────────────

describe("the GitHub step, accounts", () => {
  it("several accounts are listed, the active one first; Add another account runs gh's login again", async () => {
    const { user } = await openStep({
      github: { ...NONE, helper: "gh", accounts: [acct("mb-work"), acct("test-owner", { active: true })] },
    });
    await waitFor(() =>
      expect(within(rowOf("Account")).getByText("Signed in with 2 accounts: test-owner (active), mb-work.")).toBeTruthy(),
    );
    await user.click(within(rowOf("Account")).getByRole("button", { name: "Add another account" }));
    await waitFor(() => expect(runsOf()).toEqual(["add-account.gh"]));
    expect(await screen.findByText("Waiting for you to approve on GitHub…")).toBeTruthy();
  });
});

// ── Scopes, SSO, identity ────────────────────────────────────────────────

describe("the GitHub step, what else it can fix", () => {
  it("a token without repo/read:org: Fix runs gh auth refresh in the terminal", async () => {
    const { user } = await openStep({
      github: { ...NONE, helper: "gh", accounts: [acct("m", { active: true, scopes: "gist" })] },
    });
    const callout = (await screen.findByText("Your GitHub sign-in can't see private repositories.")).closest(".ux-callout") as HTMLElement;
    await user.click(within(callout).getByRole("button", { name: "Fix" }));
    await waitFor(() => expect(runsOf()).toEqual(["refresh.gh"]));
    expect(
      await screen.findByText("Finish in your browser: GitHub asks to let the GitHub command see your private repositories."),
    ).toBeTruthy();
  });

  it("an organization with SSO: the message names it, Authorize opens its page by the login", async () => {
    const { user } = await openStep({
      github: { ...NONE, helper: "gh", accounts: [acct("m", { active: true })], sso: { org: "acme" } },
    });
    const text = await screen.findByText("Your organization “acme” needs you to authorize the GitHub command for single sign-on.");
    await user.click(within(text.closest(".ux-callout") as HTMLElement).getByRole("button", { name: "Authorize" }));
    expect(tauri().callsOf("setup_open_github_sso").map((c) => c.args)).toEqual([{ org: "acme" }]);
  });

  // Setup opened again from Settings (this harness): the back-fill is there.
  it("commits under another email: Use my GitHub address → OB-6's sheet → the same write", async () => {
    const noreply = "1234567+test-owner@users.noreply.github.com";
    const { user } = await openStep({
      github: { ...NONE, helper: "gh", accounts: [acct("test-owner", { active: true })], githubNoreply: noreply },
    });
    const row = await waitFor(() => rowOf("Your commit email"));
    expect(row.textContent).toContain("Your commits use matteo@example.com, which your GitHub account may not know.");
    await user.click(within(row).getByRole("button", { name: "Use my GitHub address" }));
    const sheet = screen.getByRole("dialog", { name: "Set your Git name and email?" });
    expect(sheet.textContent).toContain(`git config --global user.email "${noreply}"`);
    expect(tauri().callsOf("setup_identity_write")).toEqual([]);
    await user.click(within(sheet).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(tauri().callsOf("setup_identity_write")[0]?.args).toEqual({ name: "Matteo", email: noreply }),
    );
  });

  it("no back-fill row when the commit email is GitHub's", async () => {
    await openStep({
      gitIdentity: identity("Matteo", "m@work.com"),
      github: { ...NONE, helper: "gh", accounts: [acct("m", { active: true })], githubEmail: "m@work.com", githubNoreply: "1+m@users.noreply.github.com" },
    });
    await waitFor(() => expect(within(rowOf("Account")).getByText("Signed in as m.")).toBeTruthy());
    expect(screen.queryByText("Your commit email")).toBeNull();
  });

  it("GitHub Enterprise and SSH remotes are named under Details; no token is ever shown", async () => {
    await openStep({ github: { ...NONE, helper: "gh", accounts: [acct("m", { active: true })] } });
    const dialog = screen.getByRole("dialog", { name: "Setup" });
    expect(dialog.textContent).toContain("For GitHub Enterprise, run gh auth login --hostname <your host> in a terminal");
    expect(dialog.textContent).toContain("keeps using your SSH keys");
    expect(dialog.textContent).toContain("never gives it to the agents' terminals");
    expect(dialog.textContent).not.toMatch(/gh[opsu]_/);
  });
});

// ── Skip, team mode, the checklist ───────────────────────────────────────

describe("the GitHub step, skipping and the checklist", () => {
  it("solo: Skip for now says local only and records the skip", async () => {
    const { user, tauri: stub } = await openStep();
    await user.click(footerButton("Skip for now"));
    await waitFor(() =>
      expect(useToasts.getState().toasts.map((t) => t.title)).toContain(
        "Local only. You can connect GitHub any time in Settings › Setup and account › Setup.",
      ),
    );
    await waitFor(() => {
      const saved = stub.callsOf("settings_set").map((c) => (c.args.settings as Settings).onboarding.skipped ?? {});
      expect(saved.some((s) => typeof s.github === "string")).toBe(true);
    });
  });

  it("team: the body says the team needs GitHub, and Skip warns the Team step will wait", async () => {
    const { user, tauri: stub } = await openStep({ settings: { team: { ...DEFAULT_SETTINGS.team, workMode: "team" } } });
    expect(screen.getByText("Your team needs GitHub.")).toBeTruthy();
    await user.click(footerButton("Skip for now"));
    const sheet = screen.getByRole("dialog", { name: "Skip GitHub for now?" });
    expect(sheet.textContent).toContain("Your team needs GitHub. The Team step waits until you connect it");
    // Cancel stays, nothing saved.
    await user.click(within(sheet).getByRole("button", { name: "Cancel" }));
    expect(stepTitle()).toBe(TITLE);
    const skips = () =>
      stub.callsOf("settings_set").filter((c) => typeof (c.args.settings as Settings).onboarding.skipped?.github === "string");
    expect(skips()).toEqual([]);
    await user.click(footerButton("Skip for now"));
    await user.click(within(screen.getByRole("dialog", { name: "Skip GitHub for now?" })).getByRole("button", { name: "Skip for now" }));
    await waitFor(() => expect(skips().length).toBeGreaterThan(0));
    await waitFor(() => expect(stepTitle()).not.toBe(TITLE));
  });

  it("the fast checklist's GitHub row connects in the step", async () => {
    const { user } = await openStep({
      settings: { onboarding: { ...DEFAULT_SETTINGS.onboarding, level: "fast" } },
      step: "welcome",
      github: { ...NONE, helper: "gh" },
    });
    // The fast path opens on the checklist once a step is closed.
    act(() => useSetup.setState({ step: null }));
    await user.click(await screen.findByRole("button", { name: "Back" }));
    await waitFor(() => expect(stepTitle()).toBe("Just the essentials"));
    const row = rowOf(LIST_NAME);
    await user.click(within(row).getByRole("button", { name: "Connect GitHub" }));
    await waitFor(() => expect(stepTitle()).toBe(TITLE));
    await waitFor(() => expect(runsOf()).toEqual(["login.gh"]));
  });
});

describe("Reviewer P3s", () => {
  /** The checklist, then its GitHub row. */
  async function fromChecklist(o: Opts) {
    const r = await openStep({ ...o, settings: { onboarding: { ...DEFAULT_SETTINGS.onboarding, level: "fast" } }, step: "welcome" });
    await r.user.click(await screen.findByRole("button", { name: "Back" }));
    await waitFor(() => expect(stepTitle()).toBe("Just the essentials"));
    return r;
  }
  const ready = { ...NONE, helper: "gh" as const };

  it("the checklist's Connect GitHub waits for the step's read: already signed in starts nothing", async () => {
    const answers: ((s: GithubStatus) => void)[] = [];
    const signed = { ...ready, accounts: [acct("m", { active: true })] };
    // The overlay's read answers "no account" at once; the step's detailed
    // read is slow and then says signed in.
    const { user } = await fromChecklist({
      statusFixture: ({ details }) => (details ? new Promise<GithubStatus>((res) => answers.push(res)) : ready),
    });
    await user.click(within(rowOf(LIST_NAME)).getByRole("button", { name: "Connect GitHub" }));
    await waitFor(() => expect(stepTitle()).toBe(TITLE));
    await waitFor(() => expect(answers.length).toBeGreaterThan(0));
    await nextFrame();
    expect(runsOf()).toEqual([]);
    act(() => answers.forEach((a) => a(signed)));
    await waitFor(() => expect(within(rowOf("Account")).getByText("Signed in as m.")).toBeTruthy());
    await nextFrame();
    expect(runsOf()).toEqual([]);
  });

  it("…and not signed in, it signs in once the read has answered", async () => {
    const answers: ((s: GithubStatus) => void)[] = [];
    const { user } = await fromChecklist({
      statusFixture: ({ details }) => (details ? new Promise<GithubStatus>((res) => answers.push(res)) : ready),
    });
    await user.click(within(rowOf(LIST_NAME)).getByRole("button", { name: "Connect GitHub" }));
    await waitFor(() => expect(answers.length).toBeGreaterThan(0));
    await nextFrame();
    expect(runsOf()).toEqual([]);
    act(() => answers.forEach((a) => a(ready)));
    await waitFor(() => expect(runsOf()).toEqual(["login.gh"]));
  });

  it("team mode during a sign-in: Skip asks about GitHub first, then the leave guard", async () => {
    const { user, tauri: stub } = await openStep({
      settings: { team: { ...DEFAULT_SETTINGS.team, workMode: "team" } },
      github: ready,
    });
    await waitFor(() => rowOf("Git uses your GitHub sign-in"));
    await user.click(footerButton("Connect GitHub"));
    await waitFor(() => expect(runsOf()).toEqual(["login.gh"]));
    await user.click(footerButton("Skip for now"));
    expect(screen.getByRole("dialog", { name: "Skip GitHub for now?" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Stop signing in?" })).toBeNull();
    await user.click(within(screen.getByRole("dialog", { name: "Skip GitHub for now?" })).getByRole("button", { name: "Skip for now" }));
    expect(screen.queryByRole("dialog", { name: "Skip GitHub for now?" })).toBeNull();
    const ask = screen.getByRole("dialog", { name: "Stop signing in?" });
    await user.click(within(ask).getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(stub.callsOf("setup_stop")).toHaveLength(1));
    await waitFor(() =>
      expect(
        stub.callsOf("settings_set").some((c) => typeof (c.args.settings as Settings).onboarding.skipped?.github === "string"),
      ).toBe(true),
    );
  });
});

// ── The leave guard, from any step (OB-5 → OB-7a) ────────────────────────

describe("leaving a step while its run goes on", () => {
  const ready = { ...NONE, helper: "gh" as const };

  it("the GitHub step: leaving during a sign-in asks Stop signing in?; Keep going stays, Stop stops", async () => {
    const { user } = await openStep({ github: ready });
    await waitFor(() => rowOf("Git uses your GitHub sign-in"));
    await user.click(footerButton("Connect GitHub"));
    await waitFor(() => expect(runsOf()).toEqual(["login.gh"]));
    await user.click(within(stepList()).getByRole("button", { name: /Git and your name/ }));
    const ask = screen.getByRole("dialog", { name: "Stop signing in?" });
    await user.click(within(ask).getByRole("button", { name: "Keep going" }));
    expect(stepTitle()).toBe(TITLE);
    expect(tauri().callsOf("setup_stop")).toEqual([]);

    await user.click(within(stepList()).getByRole("button", { name: /Git and your name/ }));
    await user.click(within(screen.getByRole("dialog", { name: "Stop signing in?" })).getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(tauri().callsOf("setup_stop")).toHaveLength(1));
    await waitFor(() => expect(stepTitle()).toBe("Git and your name"));
  });

  it("the Git step: leaving during the install asks Stop the installer?", async () => {
    const { user } = await openStep({
      step: "git",
      tools: [{ ...git, found: false, versionOk: false, path: null } as Tool, claude, gh(true)],
    });
    await user.click(footerButton("Install"));
    await user.click(within(screen.getByRole("dialog", { name: "Install Apple's developer tools?" })).getByRole("button", { name: "Install" }));
    await waitFor(() => expect(runsOf()).toEqual(["install.git"]));
    await user.click(screen.getByRole("button", { name: "Close setup" }));
    expect(screen.getByRole("dialog", { name: "Stop the installer?" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Keep going" }));
    expect(useSetup.getState().open).toBe(true);
    await user.click(footerButton("Skip for now"));
    expect(screen.getByRole("dialog", { name: "Stop the installer?" })).toBeTruthy();
  });

  it("a run started on one step doesn't hold another step", async () => {
    const { user } = await openStep({ github: ready });
    await waitFor(() => rowOf("Git uses your GitHub sign-in"));
    await user.click(footerButton("Connect GitHub"));
    await waitFor(() => expect(runsOf()).toEqual(["login.gh"]));
    // Stop it and leave; the Git step is then free to leave.
    await user.click(within(stepList()).getByRole("button", { name: /Git and your name/ }));
    await user.click(within(screen.getByRole("dialog", { name: "Stop signing in?" })).getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(stepTitle()).toBe("Git and your name"));
    // The old run's end arrives later; the Git step leaves freely.
    act(() =>
      tauri().emit("setup://progress", progress(started("login.gh", 1), { phase: "done", outcome: "cancelled" })),
    );
    await user.click(footerButton("Back"));
    expect(screen.queryByRole("dialog", { name: /^Stop / })).toBeNull();
    await waitFor(() => expect(stepTitle()).toBe("Your AI"));
  });

  // N14 walk F16c: Settings › Team's "Sign in to GitHub" names the team's
  // account; the step asks to sign in as it until gh has a working sign-in.
  it("opened for the team's account: says so, and Connect GitHub signs in", async () => {
    setPlatformForTests("windows");
    const { user } = await openStep({
      githubAccount: "test-user",
      github: { ...NONE, helper: "gh", accounts: [acct("test-user", { active: true, state: "refused" })] },
    });
    await waitFor(() =>
      expect(document.querySelector("[data-ply-expected-account]")?.textContent).toBe(
        "Your team uses the GitHub account test-user, which isn't signed in on this PC. Sign in as test-user; in the browser, use that GitHub account.",
      ),
    );
    await user.click(footerButton("Connect GitHub"));
    await waitFor(() => expect(runsOf()).toEqual(["login.gh"]));
    act(() => useSetup.getState().closeSetup());
  });

  it("opened for the team's account while another is signed in: the row's quiet button signs in as it", async () => {
    const { user } = await openStep({
      githubAccount: "test-user",
      github: { ...NONE, helper: "gh", accounts: [acct("mb-work", { active: true })] },
    });
    await user.click(await waitFor(() => within(rowOf("Account")).getByRole("button", { name: "Sign in as test-user" })));
    await waitFor(() => expect(runsOf()).toEqual(["add-account.gh"]));
  });

  it("opened for an account that is signed in: nothing extra", async () => {
    await openStep({
      githubAccount: "test-owner",
      github: { ...NONE, accounts: [acct("test-owner", { active: true })] },
    });
    await waitFor(() => expect(within(rowOf("Account")).getByText("Signed in as test-owner.")).toBeTruthy());
    expect(document.querySelector("[data-ply-expected-account]")).toBeNull();
  });

  it("opened for the team's account while gh isn't installed: no note", async () => {
    await openStep({ githubAccount: "test-user", tools: [git, claude, gh(false)], github: { ...NONE, ghFound: false } });
    await nextFrame();
    expect(document.querySelector("[data-ply-expected-account]")).toBeNull();
  });
});
