// OB-4 (ONBOARDING_SPEC §3, §5 steps 1, 2 and 10): the Setup overlay's
// behaviour — the step list and its state words, the footer (Back · Skip for
// now · one primary), the keyboard (Esc does not close Setup, Tab stays
// inside), the level switch, the resume point and Close setup's stamp.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SetupOverlay } from "../components/SetupOverlay";
import { Sheet } from "../components/ux";
import { useSetup } from "../store/setupStore";
import { useUi } from "../store/uiStore";
import { useWorkspaces, type Workspace } from "../store/workspaceStore";
import { DEFAULT_SETTINGS, useSettings, type Settings } from "../store/settingsStore";
import type { SetupCase } from "../lib/setupSteps";
import type { SetupStepId } from "../lib/settingsShape";
import { SETUP_VERSION } from "../lib/settingsShape";
import { setPlatformForTests } from "../lib/platform";
import { useAccount } from "../store/accountStore";
import { setUpdateFlowForTests } from "../components/UpdatePrompt";
import { UpdateFlow, type UpdateHandle } from "../lib/updateFlow";
import type { AccountInfo } from "../ipc";
import { act, fireEvent, nextFrame, renderUi, screen, waitFor, within } from "./render";
import { tauri as tauriStub } from "./tauri";

// QoL 1.168 (D6): the Your AI step's notification row reads the permission.
beforeEach(() => tauriStub().fixture("notification_access", "allowed"));

const lyra: Workspace = {
  id: "w1",
  name: "lyra",
  cwd: "/Users/someone/code/lyra",
  createdAt: 1,
  lastOpenedAt: 1,
  openFiles: [],
  activeFile: null,
};

/** Launch A2: a signed-in Free account, so step 2 is done. */
const SIGNED_IN: AccountInfo = {
  signedIn: true,
  login: "octocat",
  sub: "1",
  plan: "free",
  teamRepo: null,
  teamRole: null,
  status: null,
  periodEnd: null,
  exp: Date.UTC(2099, 0, 1),
  comp: false,
  entitlementValid: true,
  lastCheckedAt: 1,
  offline: false,
  deviceName: "Test Mac",
  lastKnownPlan: "free",
  team: null,
};
/** 1.178.0 (A3): signed out is an ordinary state. */
const SIGNED_OUT: AccountInfo = { ...SIGNED_IN, signedIn: false, login: null, sub: null, exp: null, entitlementValid: false, lastKnownPlan: null };

type Tool = { id: string; found: boolean; versionOk: boolean };
const tool = (id: string, found: boolean): Tool => ({ id, found, versionOk: found });

interface Opts {
  setupCase?: SetupCase;
  settings?: Settings;
  tools?: Tool[];
  workspaces?: Workspace[];
  configured?: string[];
  workMode?: { mode: "solo" | "team"; chosen: boolean };
  teamName?: string | null;
  account?: AccountInfo | null;
  /** An opener naming a step (Settings, the link): `useSetup`'s `step`. */
  asked?: SetupStepId;
  /** What the AI step's sign-in read answers. */
  check?: Record<string, unknown>;
}

async function open(o: Opts = {}) {
  const settings = o.settings ?? DEFAULT_SETTINGS;
  act(() => {
    useSettings.setState({ settings, loaded: true });
    useWorkspaces.setState({ workspaces: o.workspaces ?? [], activeId: o.workspaces?.[0]?.id ?? null });
    useSetup.setState({ open: true, setupCase: o.setupCase ?? "firstRun", ...(o.asked ? { step: o.asked } : {}) });
    useAccount.setState({ loaded: true, info: o.account === undefined ? SIGNED_IN : o.account });
  });
  const r = renderUi(<SetupOverlay />, {
    fixtures: {
      settings_set: ({ settings: next }: Record<string, unknown>) => next,
      dependency_doctor: {
        tools: o.tools ?? [tool("git", true), tool("claude", false), tool("codex", false), tool("gh", false)],
        allRequiredOk: false,
        whisperModel: { model: "small", present: false, path: null, detail: "Not downloaded." },
      },
      team_work_mode: o.workMode ?? { mode: "solo", chosen: false },
      team_status: { teamRepo: o.teamName ? "mb/team" : null, teamName: o.teamName ?? null, hasClone: false },
      project_config_list: (o.configured ?? []).map((id) => [id, {}]),
      // OB-12: each workspace is looked at for a commit on its branch.
      project_inspect: { git: { kind: "branch", branch: "main", commit: "abc" }, branches: ["main"] },
      // OB-12: step 7's look at the projects folder.
      projects_folder_look: { path: "/Users/someone/Projects", exists: false, notAFolder: false, projects: 0 },
      // The interim doctor under Git.
      build_cache_status: null,
      // OB-5: the AI step's own sign-in read.
      setup_check: o.check ?? { signedIn: true, method: "claude.ai", plan: "max", words: null },
      // Claude Ready: the step reads whether it trusts the review folder.
      claude_review_trust_status: { folder: "/cfg/claude-sessions", trusted: true },
      // OB-7a: step 5's read (gh found, no account).
      setup_github_status: {
        ghFound: true,
        accounts: [],
        helper: "none",
        githubEmail: null,
        githubNoreply: null,
        sso: null,
      },
      // OB-6: step 4's prefill.
      setup_identity_prefill: {
        name: "",
        nameSource: "none",
        email: "",
        emailSource: "none",
        githubNoreply: null,
        githubLogin: null,
      },
    },
  });
  await nextFrame();
  return r;
}

/** The onboarding block of every save, in order. */
const saves = (tauri: ReturnType<typeof renderUi>["tauri"]) =>
  tauri.callsOf("settings_set").map((c) => c.args.settings as Settings);
const lastSave = (tauri: ReturnType<typeof renderUi>["tauri"]) => {
  const all = saves(tauri);
  return all[all.length - 1]!;
};

const stepList = () => screen.getByRole("navigation", { name: "Setup steps" });
const currentStep = () => stepList().querySelector("[aria-current='step']")?.textContent ?? null;
const primary = (name: string) => screen.getByRole("button", { name });
const stepTitle = () => document.querySelector(".ux-setup-steptitle")?.textContent;

describe("Setup, first run", () => {
  it("opens at step 1 with the first-run header and eight steps for solo", async () => {
    await open();
    const dialog = screen.getByRole("dialog", { name: "Set up Plyloft" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.textContent).toContain(
      "A few steps, plus the time to download what it installs. You can stop at any point and pick up where you left off.",
    );
    expect(stepTitle()).toBe("Welcome to Plyloft");
    expect(dialog.textContent).toContain("Step 1 of 8");
    const items = within(stepList()).getAllByRole("button");
    expect(items.map((b) => b.querySelector(".ux-step-title")?.textContent)).toEqual([
      "Welcome",
      "Plyloft account",
      // 1.175.0 F1: the second GitHub sign-in right after the first.
      "GitHub for your projects",
      // F2: no "Solo or team" (deduced) and no "Where your projects live"
      // (a row of Your first project).
      "Your AI",
      "Git and your name",
      "Your first project",
      "Project settings",
      "Ready",
    ]);
    // F2 (I4): the quiet link under the list.
    const nav = stepList().parentElement as HTMLElement;
    expect(nav.textContent).toContain("Joining a team?");
    expect(within(nav).getByRole("button", { name: "Add the team step" })).toBeTruthy();
    expect(currentStep()).toContain("Welcome");
    // QoL 7.1 (S3-5): "I'm new to this" is preselected and Continue works
    // at once; no Skip on step 1; no Back.
    expect(screen.getByRole("radio", { name: /I'm new to this/ }).getAttribute("aria-checked")).toBe("true");
    expect((primary("Continue") as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole("button", { name: "Skip for now" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    // Required and missing: "Needs you"; the AI step says so in words.
    const ai = items.find((b) => b.textContent?.includes("Your AI"))!;
    expect(ai.textContent).toContain("Needs you");
    // SP-7: the bar's count in words beside it, the same count the bar holds.
    const bar = screen.getByRole("progressbar", { name: "Setup progress" });
    const caption = document.querySelector("[data-ply-setup-progress]")!;
    expect(caption.textContent).toMatch(/^\d+ of 8 done/);
    expect(caption.textContent!.split(" ")[0]).toBe(bar.getAttribute("aria-valuenow"));
  });

  it("step 1 saves the level on Continue and, signed in already, passes over step 2 (QoL 7.1)", async () => {
    const { user, tauri } = await open();
    expect(tauri.callsOf("settings_set")).toEqual([]);
    await user.click(primary("Continue"));
    // The Plyloft account is held, so Continue goes to the first step not
    // done: GitHub for your projects (1.175.0 F1: step 3). Step 2 stays in
    // the list, done, and opens on a click.
    await waitFor(() => expect(stepTitle()).toBe("Connect GitHub for your projects"));
    const saved = saves(tauri);
    expect(saved.some((s) => s.onboarding.level === "guided")).toBe(true);
    expect(lastSave(tauri).onboarding.currentStep).toBe("github");
    expect(screen.getByRole("dialog").textContent).toContain("Step 3 of 8");
    await user.click(primary("Skip for now"));
    // F2: no question — the next step not done.
    await waitFor(() => expect(stepTitle()).toBe("Your AI"));
    expect(within(stepList()).getByRole("button", { name: /Plyloft account/ }).textContent).toContain("Done");
    await user.click(within(stepList()).getByRole("button", { name: /Plyloft account/ }));
    await waitFor(() => expect(stepTitle()).toBe("Sign in to Plyloft"));
    expect(screen.getByRole("dialog").textContent).toContain("Step 2 of 8");
    expect(currentStep()).toContain("Plyloft account");
    // Step 2: Back, no Skip for now (Continue is its skip); signed in
    // already, so no Sign in button and Continue goes on.
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Skip for now" })).toBeNull();
    expect(screen.getByText("Signed in as octocat · Free")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign in with GitHub" })).toBeNull();
    await user.click(primary("Continue"));
    // GitHub (step 3) was skipped above, so Continue passes it over.
    await waitFor(() => expect(stepTitle()).toBe("Your AI"));
    expect(screen.getByRole("dialog").textContent).toContain("Step 4 of 8");
  });

  it("QoL 7.1 (Reviewer): Claude found by the doctor is a guess — Continue still opens Your AI", async () => {
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      onboarding: { ...DEFAULT_SETTINGS.onboarding, level: "guided", currentStep: "github" },
    };
    const { user } = await open({ settings, tools: [tool("git", true), tool("claude", true), tool("gh", false)] });
    // The doctor alone calls the AI step done…
    await waitFor(() => expect(within(stepList()).getByRole("button", { name: /Your AI/ }).textContent).toContain("Done"));
    await user.click(primary("Skip for now"));
    // …but only the step's own sign-in read is a definite answer.
    await waitFor(() => expect(stepTitle()).toBe("Your AI"));
  });

  // 1.175.0 F2 (I4): the question only from the link; With a team puts
  // Your team after Git and your name.
  it("the link asks the question; With a team adds Your team after Git and your name", async () => {
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      onboarding: { ...DEFAULT_SETTINGS.onboarding, level: "guided", currentStep: "ai" },
    };
    const { user, tauri } = await open({ settings });
    expect(stepTitle()).toBe("Your AI");
    // GitHub isn't connected here: nothing to read, so solo — never saved
    // by the deduction (F2 round 2), the link is there.
    await waitFor(() => expect(screen.getByRole("button", { name: "Add the team step" })).toBeTruthy());
    expect(saves(tauri).some((s) => s.team.workMode === "solo")).toBe(false);
    expect(tauri.callsOf("setup_team_hint")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Add the team step" }));
    await waitFor(() => expect(stepTitle()).toBe("Do you work alone or with a team?"));
    expect(screen.getByRole("dialog").textContent).toContain(
      "Plyloft found no team for octocat, so it set you up on your own. You can change this later in Settings.",
    );
    expect(within(stepList()).getAllByRole("button")[3].textContent).toContain("Solo or team");
    expect(screen.queryByRole("button", { name: "Add the team step" })).toBeNull();
    await user.click(screen.getByRole("radio", { name: /With a team/ }));
    await user.click(primary("Continue"));
    await waitFor(() => expect(lastSave(tauri).team.workMode).toBe("team"));
    const titles = within(stepList()).getAllByRole("button").map((b) => b.querySelector(".ux-step-title")?.textContent);
    expect(titles.indexOf("Your team")).toBe(titles.indexOf("Git and your name") + 1);
  });

  it("refuses solo while a workspace's board is on GitHub Issues, with a way out", async () => {
    const atelier: Workspace = { ...lyra, id: "w2", name: "Atelier", kanbanSyncMode: "githubIssues", githubOwnerRepo: "mb/atelier" };
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      onboarding: { ...DEFAULT_SETTINGS.onboarding, level: "guided", currentStep: "mode" },
    };
    const { user, tauri } = await open({ settings, asked: "mode", workspaces: [atelier], workMode: { mode: "team", chosen: false } });
    await waitFor(() => expect(stepTitle()).toBe("Do you work alone or with a team?"));
    // A team signal: With a team, deduced.
    expect(screen.getByRole("radio", { name: /With a team/ }).getAttribute("aria-checked")).toBe("true");
    await user.click(screen.getByRole("radio", { name: /On my own/ }));
    expect(
      screen.getByText(
        "“Atelier” uses a GitHub Issues board, which is a team feature. Switch its board to Local first, or keep team on.",
      ),
    ).toBeTruthy();
    expect((primary("Continue") as HTMLButtonElement).disabled).toBe(true);
    tauri.fixture("workspace_set_active", null);
    await user.click(screen.getByRole("button", { name: "Open board settings" }));
    await waitFor(() => expect(useSetup.getState().open).toBe(false));
    expect(useUi.getState().settingsSection).toBe("board");
    // Closing stamped the version: Setup will not reopen by itself.
    expect(lastSave(tauri).onboarding.setupVersion).toBe(SETUP_VERSION);
    // Solo was never written.
    expect(saves(tauri).some((s) => s.team.workMode === "solo")).toBe(false);
  });

  it("says which team it found", async () => {
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      onboarding: { ...DEFAULT_SETTINGS.onboarding, level: "guided", currentStep: "ai" },
    };
    await open({ settings, asked: "mode", workMode: { mode: "team", chosen: false }, teamName: "MB Adv" });
    expect(await screen.findByText("Plyloft found a team on this Mac: “MB Adv”.")).toBeTruthy();
  });
});

describe("Setup step 2, the Plyloft account (launch A2; optional since 1.178.0, A3)", () => {
  const at = (step: string): Settings => ({
    ...DEFAULT_SETTINGS,
    onboarding: { ...DEFAULT_SETTINGS.onboarding, level: "guided", currentStep: step },
  });
  const CODE = { attempt: 1, userCode: "WDJB-MJHT", verificationUri: "https://github.com/login/device", expiresIn: 900 };

  it("signed out (mockup 1a): Only for teams, never Needs you, Continue the one primary, Sign in bordered in the body", async () => {
    const { user, tauri } = await open({ settings: at("account"), account: SIGNED_OUT });
    tauri.fixture("account_sign_in_start", CODE);
    expect(stepTitle()).toBe("Sign in to Plyloft");
    expect(within(stepList()).getAllByRole("button")[1].textContent).not.toContain("Needs you");
    const dialog = screen.getByRole("dialog");
    expect(dialog.querySelector(".ux-page-lede")?.textContent).toBe(
      "Only for teams. Skip this if you work alone; you can sign in later in Settings › Setup and account › Plan.",
    );
    expect(dialog.textContent).toContain(
      "Sign in to Plyloft with GitHub to start or join a team. This sign-in identifies your GitHub account and grants no access to your repositories.",
    );
    // D1: "Plyloft account" vs GitHub for your projects, in words.
    expect(dialog.textContent).toContain(
      "This is separate from GitHub for your projects, the next step, which lets this Mac open pull requests. That one is for everyone who ships to GitHub, alone or in a team.",
    );
    expect(screen.getByRole("button", { name: "No GitHub account? Create one" })).toBeTruthy();
    // Continue: on, the footer's one filled primary; no Skip for now.
    expect(screen.queryByRole("button", { name: "Skip for now" })).toBeNull();
    const cont = primary("Continue") as HTMLButtonElement;
    expect(cont.disabled).toBe(false);
    expect(Array.from(dialog.querySelectorAll(".cbtn--accent"))).toEqual([cont]);
    // Sign in with GitHub: in the body, bordered.
    const signIn = primary("Sign in with GitHub");
    expect(signIn.classList.contains("cbtn--accent")).toBe(false);
    expect((dialog.querySelector(".ux-setup-content") as HTMLElement).contains(signIn)).toBe(true);
    expect((dialog.querySelector(".ux-setup-foot") as HTMLElement).contains(signIn)).toBe(false);

    await user.click(signIn);
    expect(tauri.callsOf("account_sign_in_start")).toHaveLength(1);
    expect(await screen.findByText("WDJB-MJHT")).toBeTruthy();
    // N14 F1: while GitHub waits the step's one primary is the device page,
    // beside Copy code; Continue steps aside.
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    const accents = Array.from(dialog.querySelectorAll(".cbtn--accent")).map((b) => b.textContent);
    expect(accents).toEqual(["Open github.com/login/device"]);
    const code = dialog.querySelector(".ux-signin-code") as HTMLElement;
    expect(within(code).getByRole("button", { name: "Copy code" })).toBeTruthy();
    // Signed in (mockup 1b): the status line, the step Done, no Sign in
    // button, and Continue goes on to step 3.
    // (App's listeners put the signed-in account in the store.)
    act(() => useAccount.setState({ info: SIGNED_IN, signIn: null }));
    await waitFor(() => expect(within(stepList()).getAllByRole("button")[1].textContent).toContain("Done"));
    expect(screen.getByText("Signed in as octocat · Free")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign in with GitHub" })).toBeNull();
    await user.click(primary("Continue"));
    await waitFor(() => expect(stepTitle()).toBe("Connect GitHub for your projects"));
  });

  it("Continue without signing in marks the step Skipped and goes on", async () => {
    const { user, tauri } = await open({ settings: at("account"), account: SIGNED_OUT });
    await user.click(primary("Continue"));
    await waitFor(() => expect(stepTitle()).toBe("Connect GitHub for your projects"));
    expect(typeof lastSave(tauri).onboarding.skipped?.account).toBe("string");
    await waitFor(() =>
      expect(within(stepList()).getByRole("button", { name: /Plyloft account/ }).textContent).toContain("Skipped"),
    );
    expect(tauri.callsOf("account_sign_in_start")).toHaveLength(0);
  });

  it("the fast checklist keeps Sign in to Plyloft as an optional row that opens the step", async () => {
    const { user } = await open({
      settings: { ...DEFAULT_SETTINGS, onboarding: { ...DEFAULT_SETTINGS.onboarding, level: "fast" } },
      account: null,
    });
    act(() => useAccount.setState({ info: SIGNED_OUT }));
    const list = await screen.findByRole("group", { name: "Setup checklist" });
    await user.click(within(list).getByRole("button", { name: "Sign in to Plyloft" }));
    expect(stepTitle()).toBe("Sign in to Plyloft");
    // Continue back to the checklist without signing in.
    await user.click(primary("Continue"));
    expect(await screen.findByRole("group", { name: "Setup checklist" })).toBeTruthy();
  });

  it("a dev run that skips sign-in: the note in place of Sign in, the step Skipped, Continue goes on", async () => {
    const { user } = await open({ settings: at("account"), account: null });
    act(() => useAccount.setState({ devSkip: true }));
    expect(await screen.findByText("Sign-in is skipped in this development build. Plans read as Free.")).toBeTruthy();
    await waitFor(() => expect(within(stepList()).getAllByRole("button")[1].textContent).toContain("Skipped"));
    expect(within(stepList()).getAllByRole("button")[1].textContent).not.toContain("Done");
    expect(screen.queryByRole("button", { name: "Sign in with GitHub" })).toBeNull();
    await user.click(primary("Continue"));
    await waitFor(() => expect(stepTitle()).toBe("Connect GitHub for your projects"));
  });

  it("with an update available, Setup's footer offers Install update", async () => {
    const handle: UpdateHandle = { version: "1.158.0", download: async () => {}, install: async () => {}, close: async () => {} };
    const flow = new UpdateFlow({ check: async () => handle, relaunch: async () => {}, log: { info: () => {}, error: () => {} } });
    setUpdateFlowForTests(flow);
    try {
      await flow.runCheck("poll");
      const { user } = await open({ settings: at("account") });
      await user.click(screen.getByRole("button", { name: "Install update" }));
      expect(flow.getState().kind).toBe("confirming");
    } finally {
      setUpdateFlowForTests(null);
    }
  });

  it("Ready lists the Plyloft account with the login and plan", async () => {
    await open({ settings: at("ready") });
    expect(screen.getByRole("dialog").textContent).toContain("Signed in as octocat · Free.");
  });

  it("Ready signed out (D7): what the account is for, and not a thing still to do", async () => {
    await open({ settings: at("ready"), account: SIGNED_OUT });
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Not signed in. Only needed to start or join a team.");
    const todo = screen.queryByRole("group", { name: "Still to do" });
    expect(todo?.textContent ?? "").not.toContain("Plyloft account");
  });

  // 1.171.0 A3 (walk#1/#2): a test build that skips sign-in says so.
  it("Ready on a build that skips sign-in says so, not Not signed in", async () => {
    await open({ settings: at("ready"), account: null });
    act(() => useAccount.setState({ devSkip: true }));
    const dialog = screen.getByRole("dialog");
    await waitFor(() => expect(dialog.textContent).toContain("Sign-in skipped on this test build."));
    expect(dialog.textContent).not.toContain("Not signed in. Only needed to start or join a team.");
  });

  it("Setup finishes with no account: Ready's way out closes it and stamps the version", async () => {
    const { user, tauri } = await open({
      setupCase: "existing",
      settings: {
        ...DEFAULT_SETTINGS,
        onboarding: { ...DEFAULT_SETTINGS.onboarding, firstRunCompletedAt: "2026-01-01T00:00:00Z", level: "guided", currentStep: "ready" },
      },
      workspaces: [lyra],
      account: SIGNED_OUT,
    });
    tauri.fixture("workspace_set_active", null);
    await user.click(primary("Open lyra"));
    await waitFor(() => expect(useSetup.getState().open).toBe(false));
    expect(lastSave(tauri).onboarding.setupVersion).toBe(SETUP_VERSION);
    expect(useAccount.getState().info?.signedIn).toBe(false);
  });
});

describe("Setup's footer and resume", () => {
  const resumeAt = (step: string): Settings => ({
    ...DEFAULT_SETTINGS,
    onboarding: { ...DEFAULT_SETTINGS.onboarding, level: "guided", currentStep: step },
  });

  it("resumes on the stored step, and Skip for now records the skip and moves on", async () => {
    const { user, tauri } = await open({ settings: resumeAt("ai") });
    expect(stepTitle()).toBe("Your AI");
    expect(currentStep()).toContain("Your AI");
    await user.click(primary("Skip for now"));
    await waitFor(() => expect(stepTitle()).toBe("Git and your name"));
    const saved = lastSave(tauri);
    expect(typeof saved.onboarding.skipped?.ai).toBe("string");
    expect(saved.onboarding.currentStep).toBe("git");
    await waitFor(() => expect(within(stepList()).getByRole("button", { name: /Your AI/ }).textContent).toContain("Skipped"));
    // Back returns to the step before.
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(stepTitle()).toBe("Your AI");
    // OB-5: the AI step's Continue waits for an AI that is ready.
    expect((primary("Continue") as HTMLButtonElement).disabled).toBe(true);
  });

  it("a done step has no Skip, and a step can be opened from the list", async () => {
    const { user } = await open({
      settings: resumeAt("ai"),
      tools: [tool("git", true), tool("claude", true), tool("codex", false)],
    });
    await waitFor(() => expect(within(stepList()).getByRole("button", { name: /Your AI/ }).textContent).toContain("Done"));
    expect(screen.queryByRole("button", { name: "Skip for now" })).toBeNull();
    await user.click(within(stepList()).getByRole("button", { name: /Git and your name/ }));
    expect(stepTitle()).toBe("Git and your name");
  });

  it("an unknown stored step is ignored: a first run starts at step 1", async () => {
    await open({ settings: resumeAt("a-step-from-the-future") });
    expect(stepTitle()).toBe("Welcome to Plyloft");
  });
});

describe("Setup's keyboard", () => {
  it("Esc does not close Setup", async () => {
    const { user } = await open();
    await user.keyboard("{Escape}");
    fireEvent.keyDown(screen.getByRole("button", { name: "Close setup" }), { key: "Escape" });
    expect(useSetup.getState().open).toBe(true);
    expect(screen.getByRole("dialog", { name: "Set up Plyloft" })).toBeTruthy();
  });

  it("Tab stays inside Setup", async () => {
    // jsdom lays nothing out; the trap only walks what has a box.
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
    const { user } = await open();
    const dialog = screen.getByRole("dialog");
    const first = screen.getByRole("button", { name: "Switch to just the essentials" });
    await user.click(screen.getByRole("radio", { name: /I use them regularly/ }));
    const last = primary("Continue");
    act(() => last.focus());
    await user.tab();
    expect(document.activeElement).toBe(first);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(last);
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
});

describe("the level switch", () => {
  it("goes to the checklist and back, saving the level", async () => {
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      onboarding: { ...DEFAULT_SETTINGS.onboarding, level: "guided", currentStep: "ai" },
    };
    const { user, tauri } = await open({ settings });
    await user.click(screen.getByRole("button", { name: "Switch to just the essentials" }));
    await waitFor(() => expect(stepTitle()).toBe("Just the essentials"));
    expect(lastSave(tauri).onboarding.level).toBe("fast");
    // The checklist: every step but Ready as a row; no step list beside it.
    expect(screen.queryByRole("navigation", { name: "Setup steps" })).toBeNull();
    const list = screen.getByRole("group", { name: "Setup checklist" });
    expect(list.textContent).toContain("Your AI");
    // F2: Solo or team isn't a row; the link under the checklist asks it.
    expect(within(list).queryByRole("group", { name: "Solo or team" })).toBeNull();
    expect(list.textContent).not.toContain("Where your projects live");
    expect(screen.getByRole("button", { name: "Add the team step" })).toBeTruthy();
    // A row opens its step; Back returns to the checklist.
    const gitRow = within(list).getAllByRole("button", { name: "Set up" });
    await user.click(gitRow[0]);
    expect(stepTitle()).toBe("Your AI");
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(stepTitle()).toBe("Just the essentials");
    // And back to step by step.
    await user.click(screen.getByRole("button", { name: "Switch to step by step" }));
    await waitFor(() => expect(lastSave(tauri).onboarding.level).toBe("guided"));
    expect(screen.getByRole("navigation", { name: "Setup steps" })).toBeTruthy();
  });

  it("choosing 'I use them regularly' on step 1 opens the checklist", async () => {
    const { user } = await open();
    await user.click(screen.getByRole("radio", { name: /I use them regularly/ }));
    await user.click(primary("Continue"));
    await waitFor(() => expect(stepTitle()).toBe("Just the essentials"));
  });
});

describe("closing and finishing", () => {
  it("Close setup stamps setupVersion, the resume point and the first-run stamp", async () => {
    const { user, tauri } = await open({
      settings: {
        ...DEFAULT_SETTINGS,
        onboarding: { ...DEFAULT_SETTINGS.onboarding, level: "guided", currentStep: "github" },
      },
    });
    await user.click(screen.getByRole("button", { name: "Close setup" }));
    await waitFor(() => expect(useSetup.getState().open).toBe(false));
    const { onboarding } = lastSave(tauri);
    expect(onboarding.setupVersion).toBe(SETUP_VERSION);
    expect(onboarding.currentStep).toBe("github");
    expect(onboarding.firstRunCompletedAt).toMatch(/^\d{4}-/);
  });

  it("an existing user sees detected steps done and lands on the first not done", async () => {
    await open({
      setupCase: "existing",
      settings: {
        ...DEFAULT_SETTINGS,
        onboarding: { ...DEFAULT_SETTINGS.onboarding, firstRunCompletedAt: "2026-01-01T00:00:00Z", level: "guided" },
        identity: { userEmail: "me@example.com" },
        team: { ...DEFAULT_SETTINGS.team, workMode: "solo" },
      },
      tools: [tool("git", true), tool("claude", true), tool("codex", false), tool("gh", true)],
      workspaces: [lyra],
      configured: [lyra.id],
    });
    expect(screen.getByRole("dialog", { name: "Plyloft can now set itself up" })).toBeTruthy();
    await waitFor(() => expect(stepTitle()).toBe("Connect GitHub for your projects"));
    const words = within(stepList())
      .getAllByRole("button")
      .map((b) => [b.querySelector(".ux-step-title")?.textContent, b.querySelector(".ux-step-state")?.textContent ?? ""]);
    expect(words).toEqual([
      ["Welcome", "Done"],
      ["Plyloft account", "Done"],
      ["GitHub for your projects", ""],
      ["Your AI", "Done"],
      ["Git and your name", "Done"],
      ["Your first project", "Done"],
      ["Project settings", "Done"],
      ["Ready", "Done"],
    ]);
  });

  it("Windows walk: Ready shows the projects folder as Settings does on Windows", async () => {
    setPlatformForTests("windows");
    try {
      await open({
        settings: {
          ...DEFAULT_SETTINGS,
          onboarding: { ...DEFAULT_SETTINGS.onboarding, level: "guided", currentStep: "ready" },
        },
      });
      await waitFor(() => expect(stepTitle()).toBe("Setup isn't finished"));
      expect(screen.getByRole("dialog").textContent).toContain("%USERPROFILE%\\Projects");
      expect(screen.getByRole("dialog").textContent).not.toContain("~/Projects");
    } finally {
      setPlatformForTests(null);
    }
  });

  it("Ready sums up, offers no tour while something required is missing, and opens the workspace", async () => {
    const { user, tauri } = await open({
      setupCase: "existing",
      settings: {
        ...DEFAULT_SETTINGS,
        onboarding: {
          ...DEFAULT_SETTINGS.onboarding,
          firstRunCompletedAt: "2026-01-01T00:00:00Z",
          level: "guided",
          currentStep: "ready",
        },
      },
      workspaces: [lyra],
    });
    tauri.fixture("workspace_set_active", null);
    expect(stepTitle()).toBe("Setup isn't finished");
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("No AI tool is ready, so Plyloft can't build a card yet.");
    expect(dialog.textContent).toContain("Local only.");
    // Required items not done are listed with Finish.
    const todo = screen.getByRole("group", { name: "Still to do" });
    expect(within(todo).getByText("Your AI")).toBeTruthy();
    // 1.176.4: with no AI tool ready the tour is not offered at all.
    expect(screen.queryByRole("button", { name: "Try a guided first card" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Start the tour" })).toBeNull();
    expect(dialog.textContent).not.toContain("The Getting started tour");
    // No Skip on Ready; the primary opens the workspace.
    expect(screen.queryByRole("button", { name: "Skip for now" })).toBeNull();
    // Finish on a still-to-do row goes to its step, and Continue comes back.
    await user.click(within(todo).getAllByRole("button", { name: "Finish" })[0]);
    expect(stepTitle()).toBe("Your AI");
    await user.click(within(stepList()).getByRole("button", { name: /Ready/ }));
    expect(stepTitle()).toBe("Setup isn't finished");
    await user.click(primary("Open lyra"));
    await waitFor(() => expect(useSetup.getState().open).toBe(false));
    expect(lastSave(tauri).onboarding.setupVersion).toBe(SETUP_VERSION);
    expect(useUi.getState().centerMode[lyra.id]).toBe("board");
  });
});

describe("1.176.4: the AI and Git steps say why and what", () => {
  const guided = { ...DEFAULT_SETTINGS, onboarding: { ...DEFAULT_SETTINGS.onboarding, level: "guided" as const } };

  it("a disabled Continue says what is missing, and Skip says what won't work", async () => {
    const { user } = await open({ settings: guided, asked: "ai" });
    await waitFor(() => expect(stepTitle()).toBe("Your AI"));
    const foot = document.querySelector(".ux-setup-foot") as HTMLElement;
    const cont = within(foot).getByRole("button", { name: "Continue" }) as HTMLButtonElement;
    expect(cont.disabled).toBe(true);
    expect(document.querySelector("[data-ply-continue-reason]")?.textContent).toBe(
      "Install Claude Code or Codex to go on, or press Skip for now.",
    );
    expect(screen.getByRole("dialog").textContent).toContain("If you skip it, Plyloft can't build cards until an AI tool is ready.");
    const skip = within(foot).getByRole("button", { name: "Skip for now" });
    expect(skip.getAttribute("title")).toBe("Plyloft can't build cards until an AI tool is ready.");
    await user.click(skip);
    const toasts = (await import("../store/toastStore")).useToasts.getState().toasts.map((t) => t.title);
    expect(toasts.some((t) => t.includes("Plyloft can't build cards until an AI tool is ready."))).toBe(true);
  });

  it("an installed but signed-out tool: the reason says sign in", async () => {
    await open({
      settings: guided,
      asked: "ai",
      tools: [tool("git", true), tool("claude", true), tool("codex", false), tool("gh", false)],
      check: { signedIn: false, method: "none", plan: null, words: null },
    });
    await waitFor(() => expect(stepTitle()).toBe("Your AI"));
    await waitFor(() =>
      expect(document.querySelector("[data-ply-continue-reason]")?.textContent).toBe(
        "Sign in to Claude Code to go on, or press Skip for now.",
      ),
    );
  });

  it("an installed tool that is too old: the reason says so, not Sign in", async () => {
    await open({
      settings: guided,
      asked: "ai",
      tools: [tool("git", true), { id: "claude", found: true, versionOk: false }, tool("codex", false), tool("gh", false)],
    });
    await waitFor(() => expect(stepTitle()).toBe("Your AI"));
    await waitFor(() =>
      expect(document.querySelector("[data-ply-continue-reason]")?.textContent).toBe(
        "Claude Code: Installed but too old. Update it to use it with Plyloft. Or press Skip for now.",
      ),
    );
  });

  it("the Git step says what skipping leaves undone", async () => {
    await open({ settings: guided, asked: "git", tools: [tool("git", false), tool("claude", false), tool("codex", false), tool("gh", false)] });
    await waitFor(() => expect(stepTitle()).toBe("Git and your name"));
    expect(screen.getByRole("dialog").textContent).toContain("If you skip it, Plyloft can't give cards their own copy of your code until Git works.");
  });
});

describe("Setup's placeholders and what sits under it (OB-4 review)", () => {
  it("every step is built: step 9 with no project yet says so in plain words, with no card id", async () => {
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      onboarding: { ...DEFAULT_SETTINGS.onboarding, level: "guided", currentStep: "config" },
    };
    await open({ settings });
    expect(screen.queryByText("This step isn't ready yet.")).toBeNull();
    expect(screen.getByText("Add a project first. Plyloft sets up how it builds a project once it's in.")).toBeTruthy();
    expect(screen.getByRole("dialog").textContent).not.toMatch(/\bOB-\d/);
  });

  it("the AI step shows its own tool rows only — nothing that opens Settings under Setup", async () => {
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      onboarding: { ...DEFAULT_SETTINGS.onboarding, level: "guided", currentStep: "ai" },
    };
    await open({ settings });
    const r = screen.getByRole("dialog");
    await waitFor(() => expect(r.textContent).toContain("Look again"));
    // The report below carries a missing Whisper model, whose row opens
    // Settings › Dictation elsewhere.
    expect(screen.queryByRole("button", { name: "Open Dictation settings" })).toBeNull();
    expect(r.textContent).not.toContain("Whisper model");
  });

  it("a sheet under the inert shell takes no Esc while Setup is up", async () => {
    const onClose = vi.fn();
    act(() => {
      useSettings.setState({ settings: DEFAULT_SETTINGS, loaded: true });
      useSetup.setState({ open: true, setupCase: "rerun" });
    });
    const { user } = renderUi(
      <>
        <SetupOverlay />
        {/* Mounted after Setup, so it is on top of the dialog stack. */}
        <div inert>
          <Sheet title="A question in the shell" onClose={onClose} />
        </div>
      </>,
      {
        fixtures: {
          dependency_doctor: { tools: [], allRequiredOk: true },
          team_work_mode: { mode: "solo", chosen: false },
          team_status: { teamRepo: null, teamName: null, hasClone: false },
          project_config_list: [],
        },
      },
    );
    await nextFrame();
    act(() => screen.getByRole("button", { name: "Close setup" }).focus());
    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
    expect(useSetup.getState().open).toBe(true);
  });
});
