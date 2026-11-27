// OB-5 (ONBOARDING_SPEC §5 step 3): Setup's AI tools step, with the runner
// and the IPC stubbed — every row state and its transitions (install →
// running → re-probe → Ready; sign in; cancel; the ten-minute wait), the
// plan warning, an API key, Codex only, Claude only, both (the Builder
// choice), the failures, Windows' Git for Windows first and Codex's
// install.ps1, and that `setup_check` runs in this step only (D2, D4).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AiToolsStep } from "../components/SetupAiStep";
import { SetupOverlay } from "../components/SetupOverlay";
import { useSetup } from "../store/setupStore";
import { useRepair } from "../store/repairStore";
import { useWorkspaces } from "../store/workspaceStore";
import { DEFAULT_SETTINGS, useSettings, type Settings } from "../store/settingsStore";
import { setPlatformForTests } from "../lib/platform";
import type { SetupProgressEvent, SetupSignInAnswer, SetupStarted } from "../ipc";
import { setPfCheckMsForTests } from "../lib/aiTools";
import { act, nextFrame, renderUi, screen, waitFor, within } from "./render";
import { tauri } from "./tauri";

// QoL 1.168 (D6): the step's notification row reads the permission.
beforeEach(() => tauri().fixture("notification_access", "allowed"));

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

// ── The machine ──────────────────────────────────────────────────────────

type ToolRow = {
  id: string;
  found: boolean;
  versionOk: boolean;
  version?: string | null;
  installCmd: string;
  update?: { latest: string; detail: string; command: string } | null;
};
const CLAUDE_INSTALL = "curl -fsSL https://claude.ai/install.sh | bash";
const CODEX_INSTALL = "curl -fsSL https://chatgpt.com/codex/install.sh | sh";
const claude = (found: boolean, over: Partial<ToolRow> = {}): ToolRow => ({
  id: "claude",
  found,
  versionOk: found,
  installCmd: CLAUDE_INSTALL,
  ...over,
});
const codex = (found: boolean, over: Partial<ToolRow> = {}): ToolRow => ({
  id: "codex",
  found,
  versionOk: found,
  installCmd: CODEX_INSTALL,
  ...over,
});
const git: ToolRow = { id: "git", found: true, versionOk: true, installCmd: "xcode-select --install" };

/** The doctor as it is now; a test changes it as a run would. */
let tools: ToolRow[] = [];
const report = () => ({ tools, allRequiredOk: false });

const max: SetupSignInAnswer = { signedIn: true, method: "claude.ai", plan: "max", words: null };
const signedOut: SetupSignInAnswer = { signedIn: false, method: "none", plan: null, words: null };
const chatgpt: SetupSignInAnswer = { signedIn: true, method: "chatgpt", plan: null, words: "Logged in using ChatGPT" };
/** What `setup_check` answers, per tool; a test changes it. */
let status: Record<"claude" | "codex", SetupSignInAnswer> = { claude: max, codex: chatgpt };
/** Claude's answer about Plyloft's review folder (a file read); trusted unless
 *  a test says otherwise. */
const REVIEW_FOLDER = "/Users/me/Library/Application Support/com.mbadv.ply/claude-sessions";
let reviewTrust: { folder: string; trusted: boolean | null } = { folder: REVIEW_FOLDER, trusted: true };

function started(actionId: SetupStarted["actionId"], n = 1): SetupStarted {
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
const emit = (run: SetupStarted, over: Partial<SetupProgressEvent>) =>
  act(() => tauri().emit("setup://progress", progress(run, over)));

function fixtures(settings: Settings) {
  let n = 0;
  return {
    dependency_doctor: () => report(),
    shell_env_info: {},
    shell_env_retry: {},
    settings_set: ({ settings: next }: Record<string, unknown>) => next,
    setup_check: ({ actionId }: Record<string, unknown>) =>
      actionId === "status.claude" ? status.claude : status.codex,
    setup_reach: { reachable: true, proxy: false, details: null },
    setup_run: ({ actionId }: Record<string, unknown>) => {
      const run = started(actionId as SetupStarted["actionId"], ++n);
      tauri().emit("setup://progress", progress(run, {}));
      return run;
    },
    setup_stop: true,
    setup_active: null,
    setup_open_page: null,
    pty_resize: null,
    claude_review_trust_status: () => reviewTrust,
    __settings: settings,
  };
}

async function step(o: { tools: ToolRow[]; settings?: Settings; guided?: boolean } ) {
  tools = o.tools;
  const settings = o.settings ?? DEFAULT_SETTINGS;
  act(() => useSettings.setState({ settings, loaded: true }));
  const observed = vi.fn();
  const { __settings: _, ...fx } = fixtures(settings);
  const r = renderUi(<AiToolsStep guided={o.guided ?? true} onObserved={observed} />, { fixtures: fx });
  await nextFrame();
  return { ...r, observed };
}

const rowOf = (label: string) => {
  const group = screen.getByRole("group", { name: "AI tools" });
  const rows = Array.from(group.querySelectorAll(".ux-row"));
  const row = rows.find((r) => r.textContent?.startsWith(label));
  if (!row) throw new Error(`no row ${label}: ${rows.map((r) => r.textContent).join(" | ")}`);
  return row as HTMLElement;
};
const lastObserved = (spy: ReturnType<typeof vi.fn>) => spy.mock.calls[spy.mock.calls.length - 1]?.[0];
const savedBehavior = () => {
  const calls = tauri().callsOf("settings_set");
  return calls.length ? (calls[calls.length - 1].args.settings as Settings).behavior : null;
};

describe("1.176.4: the AI step says what its actions do", () => {
  it("the chosen tool's Install is the filled one; both or none keep today's weights", async () => {
    status = { claude: max, codex: chatgpt };
    const { user } = await step({ tools: [git, claude(false), codex(false)] });
    const which = screen.getByRole("group", { name: "Which do you have?" });
    expect(rowOf("Claude Code").querySelector("button")?.className).toMatch(/cbtn--strong/);
    expect(rowOf("Codex").querySelector("button")?.className).toMatch(/cbtn--strong/);
    await user.click(within(which).getByLabelText("ChatGPT (Plus, Pro or Business) for Codex"));
    expect(rowOf("Codex").querySelector("button")?.className).toMatch(/cbtn--accent/);
    expect(rowOf("Also use Claude Code").querySelector("button")?.className).toMatch(/cbtn--quiet/);
    await user.click(within(which).getByLabelText(/Claude/));
    expect(rowOf("Claude Code").querySelector("button")?.className).toMatch(/cbtn--strong/);
    expect(rowOf("Codex").querySelector("button")?.className).toMatch(/cbtn--strong/);
  });

  it("says what each Install downloads and from where, and who the subscription is paid to", async () => {
    status = { claude: max, codex: chatgpt };
    await step({ tools: [git, claude(false), codex(false)] });
    expect(screen.getByText(/Claude Code: Install downloads Anthropic's installer from claude\.ai/)).toBeTruthy();
    expect(screen.getByText(/Codex: Install downloads OpenAI's installer from chatgpt\.com/)).toBeTruthy();
    expect(screen.getByText("The Claude or ChatGPT subscription is paid to Anthropic or OpenAI. Plyloft doesn't include it.")).toBeTruthy();
  });

  it("with a tool installed there is no Install line for it", async () => {
    status = { claude: max, codex: chatgpt };
    await step({ tools: [git, claude(true), codex(false)] });
    expect(screen.queryByText(/Claude Code: Install downloads/)).toBeNull();
    expect(screen.getByText(/Codex: Install downloads/)).toBeTruthy();
  });
});

describe("1.176.4: Open Program folders only when Repair's own check blames the setting", () => {
  const withFolders = { ...DEFAULT_SETTINGS, shell: { ...DEFAULT_SETTINGS.shell, pathOverride: "/opt/bin" } };
  const plan = (tool: string, situations: unknown[]) => ({ tool, situations, notes: [], steps: [], block: null, nextStep: null, manual: [], quick: true, updateBlocked: false });
  const outside = { kind: "outsideProgramFolders", copy: "/Users/me/.local/bin/claude", folder: "/Users/me/.local/bin", problems: [] };

  it("the check says outside the folders you set: the row offers Open Program folders, never Install", async () => {
    status = { claude: max, codex: chatgpt };
    tauri().fixture("cli_repair_plan", ({ tool }: Record<string, unknown>) => plan(tool as string, tool === "claude" ? [outside] : []));
    await step({ tools: [git, claude(false), codex(false)], settings: withFolders });
    await waitFor(() => expect(within(rowOf("Claude Code")).getByRole("button", { name: "Open Program folders" })).toBeTruthy());
    expect(within(rowOf("Claude Code")).queryByRole("button", { name: "Install" })).toBeNull();
    // Codex isn't blamed on the setting: it is simply not installed.
    await waitFor(() => expect(within(rowOf("Codex")).getByRole("button", { name: "Install" })).toBeTruthy());
    expect(within(rowOf("Codex")).queryByRole("button", { name: "Open Program folders" })).toBeNull();
    expect(tauri().callsOf("cli_repair_plan").every((c) => (c.args.request as { quick?: boolean }).quick === true)).toBe(true);
  });

  it("the check can't say, or fails: Install stays", async () => {
    status = { claude: max, codex: chatgpt };
    tauri().fixture("cli_repair_plan", () => {
      throw new Error("no");
    });
    await step({ tools: [git, claude(false), codex(false)], settings: withFolders });
    await waitFor(() => expect(within(rowOf("Claude Code")).getByRole("button", { name: "Install" })).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Open Program folders" })).toBeNull();
  });

  it("Repair can't tell yet: no Install, its own words; Look again asks the check again", async () => {
    status = { claude: max, codex: chatgpt };
    let again = false;
    tauri().fixture("cli_repair_plan", ({ tool }: Record<string, unknown>) =>
      again
        ? plan(tool as string, tool === "claude" ? [outside] : [])
        : { ...plan(tool as string, []), block: { kind: "notSureYet", paths: [] } },
    );
    const { user } = await step({ tools: [git, claude(false), codex(false)], settings: withFolders });
    await waitFor(() => expect(rowOf("Claude Code").textContent).toContain("Can't tell yet. Try again in a moment."));
    expect(within(rowOf("Claude Code")).queryByRole("button", { name: "Install" })).toBeNull();
    const before = tauri().callsOf("cli_repair_plan").length;
    again = true;
    await user.click(within(rowOf("Claude Code")).getByRole("button", { name: "Look again" }));
    // One more read per tool that isn't fine.
    await waitFor(() => expect(tauri().callsOf("cli_repair_plan").length).toBe(before + 2));
    await waitFor(() => expect(within(rowOf("Claude Code")).getByRole("button", { name: "Open Program folders" })).toBeTruthy());
    expect(within(rowOf("Codex")).getByRole("button", { name: "Install" })).toBeTruthy();
  });

  it("a check that never answers is given up after its limit: the row is normal again", async () => {
    status = { claude: max, codex: chatgpt };
    setPfCheckMsForTests(60);
    try {
      tauri().fixture("cli_repair_plan", () => new Promise(() => {}));
      await step({ tools: [git, claude(false), codex(false)], settings: withFolders });
      expect(rowOf("Claude Code").textContent).toContain("Looking…");
      await waitFor(() => expect(within(rowOf("Claude Code")).getByRole("button", { name: "Install" })).toBeTruthy());
      expect(screen.queryByRole("button", { name: "Open Program folders" })).toBeNull();
    } finally {
      setPfCheckMsForTests(null);
    }
  });

  it("while the check is out the row says it is looking, with no button", async () => {
    status = { claude: max, codex: chatgpt };
    tauri().fixture("cli_repair_plan", () => new Promise(() => {}));
    await step({ tools: [git, claude(false), codex(false)], settings: withFolders });
    expect(rowOf("Claude Code").textContent).toContain("Looking…");
    expect(within(rowOf("Claude Code")).queryByRole("button")).toBeNull();
  });

  it("with no Program folders set nothing is asked", async () => {
    status = { claude: max, codex: chatgpt };
    await step({ tools: [git, claude(false), codex(false)] });
    expect(tauri().callsOf("cli_repair_plan")).toHaveLength(0);
    expect(within(rowOf("Claude Code")).getByRole("button", { name: "Install" })).toBeTruthy();
  });
});

describe("the AI tools step, fresh machine", () => {
  it("asks which you have; only the ticked tool's Install is strong; Neither yet opens the plan pages", async () => {
    status = { claude: max, codex: chatgpt };
    const { user, observed } = await step({ tools: [git, claude(false), codex(false)] });
    expect(rowOf("Claude Code").textContent).toContain("Not installed.");
    expect(rowOf("Codex").textContent).toContain("Not installed.");
    expect(screen.getByText(/never uses an API key\..*never into Plyloft\..*only to show its code and see when you're done, and never saves it/)).toBeTruthy();
    const which = screen.getByRole("group", { name: "Which do you have?" });

    await user.click(within(which).getByLabelText("ChatGPT (Plus, Pro or Business) for Codex"));
    expect(rowOf("Codex").querySelector("button")?.className).not.toMatch(/quiet/);
    expect(rowOf("Also use Claude Code").querySelector("button")?.className).toMatch(/quiet/);

    await user.click(within(which).getByLabelText("Neither yet"));
    expect((within(which).getByLabelText("ChatGPT (Plus, Pro or Business) for Codex") as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText("You'll need one subscription. Sign up in your browser, then come back here.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Get Claude" }));
    await user.click(screen.getByRole("button", { name: "Get ChatGPT" }));
    expect(tauri().callsOf("setup_open_page").map((c) => c.args)).toEqual([{ page: "get-claude" }, { page: "get-chatgpt" }]);

    // Nothing installed: nothing to ask about sign-in, and `ai` doesn't hold.
    expect(tauri().callsOf("setup_check")).toEqual([]);
    expect(lastObserved(observed)).toBe(false);
  });

  it("installs Claude Code: sheet with the command → offline check → run → re-probe → sign-in read → Ready with the plan", async () => {
    status = { claude: max, codex: chatgpt };
    const { user, observed } = await step({ tools: [git, claude(false), codex(false)] });
    await user.click(within(rowOf("Claude Code")).getByRole("button", { name: "Install" }));

    const sheet = screen.getByRole("dialog", { name: "Install Claude Code?" });
    expect(sheet.textContent).toContain(
      "Plyloft will download and run the installer Anthropic publishes. It installs for your user only and doesn't need an administrator.",
    );
    expect(within(sheet).getByText(CLAUDE_INSTALL)).toBeTruthy();
    expect(tauri().callsOf("setup_run")).toEqual([]);
    await user.click(within(sheet).getByRole("button", { name: "Install" }));

    await waitFor(() => expect(tauri().callsOf("setup_run")).toHaveLength(1));
    expect(tauri().callsOf("setup_reach")[0].args).toEqual({ actionId: "install.claude" });
    // Only the id crosses: never a command.
    expect(tauri().callsOf("setup_run")[0].args).toEqual({ actionId: "install.claude", args: null, cols: null, rows: null });
    await waitFor(() => expect(rowOf("Claude Code").textContent).toContain("Installing… this takes about a minute."));
    expect(screen.getByText("Installing Claude Code… this takes about a minute.")).toBeTruthy();

    // Rust saw it work and re-probed; the doctor now finds it.
    tools = [git, claude(true), codex(false)];
    emit(started("install.claude"), { phase: "done", outcome: "succeeded", exitCode: 0, reprobed: true });
    await waitFor(() => expect(tauri().callsOf("setup_check").map((c) => c.args)).toEqual([{ actionId: "status.claude" }]));
    await waitFor(() => expect(rowOf("Claude Code").textContent).toContain("Ready. Signed in with Claude Max."));
    await waitFor(() => expect(lastObserved(observed)).toBe(true));
    // Claude only: the info callout, and nothing to write (Claude is the default).
    expect(screen.getByText("Claude will build and review your cards.")).toBeTruthy();
    expect(tauri().callsOf("settings_set")).toEqual([]);
  });

  it("offline: nothing runs, and the block says so with Try again · Do it yourself", async () => {
    const { user } = await step({ tools: [git, claude(false), codex(false)] });
    tauri().fixture("setup_reach", { reachable: false, proxy: true, details: "curl: (56) CONNECT tunnel failed, response 407" });
    await user.click(within(rowOf("Claude Code")).getByRole("button", { name: "Install" }));
    await user.click(within(screen.getByRole("dialog", { name: "Install Claude Code?" })).getByRole("button", { name: "Install" }));
    await waitFor(() => expect(screen.getByText("You're offline, or this network blocks the download.")).toBeTruthy());
    expect(screen.getByText("Nothing was installed.")).toBeTruthy();
    expect(screen.getByText(/Your network may use a proxy/)).toBeTruthy();
    expect(tauri().callsOf("setup_run")).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Do it yourself" }));
    expect(tauri().callsOf("setup_open_page")[0].args).toEqual({ page: "install-claude" });
  });

  it("an installer that fails shows the error block; one not found after says Quit and reopen", async () => {
    const { user } = await step({ tools: [git, claude(false), codex(false)] });
    await user.click(within(rowOf("Claude Code")).getByRole("button", { name: "Install" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Install" }));
    await waitFor(() => expect(tauri().callsOf("setup_run")).toHaveLength(1));
    emit(started("install.claude"), { phase: "done", outcome: "failed", exitCode: 22, tail: ["curl: (22) 500"] });
    expect(screen.getByText("Claude Code's installer stopped with an error.")).toBeTruthy();
    expect(screen.getByText("Nothing else was changed.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(tauri().callsOf("setup_run")).toHaveLength(2));
    emit(started("install.claude", 2), { phase: "done", outcome: "not-observed", exitCode: 0, reprobed: true });
    await waitFor(() =>
      expect(rowOf("Claude Code").textContent).toContain("Installed, but Plyloft can't find it yet. Quit and reopen Plyloft."),
    );
    expect(screen.queryByText("Claude Code's installer stopped with an error.")).toBeNull();
  });
});

describe("signing in", () => {
  it("installed, not signed in → Sign in (no sheet) → signing in → read again → Ready", async () => {
    status = { claude: signedOut, codex: chatgpt };
    const { user, observed } = await step({ tools: [git, claude(true), codex(false)] });
    await waitFor(() => expect(rowOf("Claude Code").textContent).toContain("Installed. Not signed in yet."));
    await waitFor(() => expect(lastObserved(observed)).toBe(false));
    await user.click(within(rowOf("Claude Code")).getByRole("button", { name: "Sign in" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(tauri().callsOf("setup_run")[0]?.args.actionId).toBe("login.claude"));
    expect(tauri().callsOf("setup_reach")).toEqual([]);
    await waitFor(() =>
      expect(rowOf("Claude Code").textContent).toContain("Finish signing in in your browser. Plyloft notices when you're done."),
    );
    status = { ...status, claude: max };
    emit(started("login.claude"), { phase: "done", outcome: "succeeded", exitCode: 0 });
    await waitFor(() => expect(rowOf("Claude Code").textContent).toContain("Ready. Signed in with Claude Max."));
    expect(tauri().callsOf("setup_check")).toHaveLength(2);
    await waitFor(() => expect(lastObserved(observed)).toBe(true));
  });

  it("a cancelled sign-in is just Not signed in yet — no error", async () => {
    status = { claude: signedOut, codex: chatgpt };
    const { user } = await step({ tools: [git, claude(true), codex(false)] });
    await waitFor(() => expect(rowOf("Claude Code").textContent).toContain("Not signed in yet."));
    await user.click(within(rowOf("Claude Code")).getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(tauri().callsOf("setup_run")).toHaveLength(1));
    emit(started("login.claude"), { phase: "done", outcome: "cancelled", exitCode: 130 });
    await waitFor(() => expect(tauri().callsOf("setup_check")).toHaveLength(2));
    expect(rowOf("Claude Code").textContent).toContain("Installed. Not signed in yet.");
    expect(document.querySelector(".ux-error")).toBeNull();
    expect(within(rowOf("Claude Code")).getByRole("button", { name: "Sign in" })).toBeTruthy();
  });

  it("the ten-minute wait: Keep waiting stops nothing; Stop stops the run", async () => {
    status = { claude: signedOut, codex: chatgpt };
    const { user } = await step({ tools: [git, claude(true), codex(false)] });
    await waitFor(() => expect(rowOf("Claude Code").textContent).toContain("Not signed in yet."));
    await user.click(within(rowOf("Claude Code")).getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(tauri().callsOf("setup_run")).toHaveLength(1));
    emit(started("login.claude"), { phase: "waiting-long" });
    const callout = () => screen.queryByRole("button", { name: "Keep waiting" });
    expect(callout()).toBeTruthy();
    await user.click(callout()!);
    expect(callout()).toBeNull();
    expect(tauri().callsOf("setup_stop")).toEqual([]);
    // A second long wait of the same run stays quiet; Stop is still there.
    const stops = screen.getAllByRole("button", { name: "Stop" });
    await user.click(stops[0]);
    expect(tauri().callsOf("setup_stop")[0].args).toEqual({ runId: "run-login.claude-1" });
  });

  it("Codex: Sign in with a code instead stops the browser sign-in and starts the device one", async () => {
    status = { claude: max, codex: signedOut };
    const { user } = await step({ tools: [git, claude(false), codex(true)] });
    await waitFor(() => expect(rowOf("Codex").textContent).toContain("Not signed in yet."));
    await user.click(within(rowOf("Codex")).getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(tauri().callsOf("setup_run")[0]?.args.actionId).toBe("login.codex"));
    await user.click(screen.getByRole("button", { name: "Sign in with a code instead" }));
    expect(tauri().callsOf("setup_stop")).toHaveLength(1);
    emit(started("login.codex"), { phase: "done", outcome: "cancelled" });
    await waitFor(() => expect(tauri().callsOf("setup_run")[1]?.args.actionId).toBe("login-device.codex"));
  });
});

describe("the plan, an API key, and who builds", () => {
  it("Claude Pro: Ready with the plan and the warning callout; never a block", async () => {
    status = { claude: { signedIn: true, method: "claude.ai", plan: "pro", words: null }, codex: chatgpt };
    const { observed } = await step({ tools: [git, claude(true), codex(false)] });
    await waitFor(() => expect(rowOf("Claude Code").textContent).toContain("Ready. Signed in with Claude Pro."));
    expect(screen.getByText("Claude Pro works with Plyloft.")).toBeTruthy();
    expect(screen.getByText(/Pro reaches its usage limit sooner than Max/)).toBeTruthy();
    await waitFor(() => expect(lastObserved(observed)).toBe(true));
  });

  it("an API key: Ready, with an API key — no warning (D3)", async () => {
    status = { claude: { signedIn: true, method: "api_key", plan: null, words: null }, codex: chatgpt };
    await step({ tools: [git, claude(true), codex(false)] });
    await waitFor(() => expect(rowOf("Claude Code").textContent).toContain("Ready, with an API key."));
    expect(screen.queryByText("Claude Pro works with Plyloft.")).toBeNull();
  });

  it("could not tell: the neutral words and a quiet Sign in; the step is not blocked", async () => {
    status = { claude: { signedIn: null, method: null, plan: null, words: null }, codex: chatgpt };
    const { observed } = await step({ tools: [git, claude(true), codex(false)] });
    // Couldn't tell twice (the read, then its one retry 2 s later): unsure,
    // and no third read by itself.
    await waitFor(
      () =>
        expect(rowOf("Claude Code").textContent).toContain(
          "Installed. Plyloft couldn't tell whether you're signed in; if your Claude tiles start, this is fine.",
        ),
      { timeout: 5000 },
    );
    const claudeReads = () => tauri().callsOf("setup_check").filter((c) => c.args.actionId === "status.claude");
    expect(claudeReads()).toHaveLength(2);
    expect(within(rowOf("Claude Code")).getByRole("button", { name: "Sign in" }).className).toMatch(/quiet/);
    await waitFor(() => expect(lastObserved(observed)).toBe(true));
    await new Promise((done) => setTimeout(done, 2500));
    expect(claudeReads()).toHaveLength(2);
  }, 15000);

  it("a read still out when the step goes away schedules no retry after it", async () => {
    let answer: (a: SetupSignInAnswer) => void = () => {};
    const pending = new Promise<SetupSignInAnswer>((done) => (answer = done));
    tools = [git, claude(true), codex(false)];
    act(() => useSettings.setState({ settings: DEFAULT_SETTINGS, loaded: true }));
    const { __settings: _, ...fx } = fixtures(DEFAULT_SETTINGS);
    const { unmount } = renderUi(<AiToolsStep guided onObserved={vi.fn()} />, {
      fixtures: { ...fx, setup_check: () => pending },
    });
    await waitFor(() => expect(tauri().callsOf("setup_check")).toHaveLength(1));
    unmount();
    answer({ signedIn: null, method: null, plan: null, words: null });
    await new Promise((done) => setTimeout(done, 2500));
    expect(tauri().callsOf("setup_check")).toHaveLength(1);
  }, 10000);

  it.each(["claude", "codex"] as const)(
    "a %s read that couldn't tell (a cold start past the 6 s bound) is read once more by itself: Ready without a press",
    async (tool) => {
      const unknown = { signedIn: null, method: null, plan: null, words: null };
      let n = 0;
      status = { claude: max, codex: chatgpt };
      tools = tool === "claude" ? [git, claude(true), codex(false)] : [git, claude(false), codex(true)];
      act(() => useSettings.setState({ settings: DEFAULT_SETTINGS, loaded: true }));
      const { __settings: _, ...fx } = fixtures(DEFAULT_SETTINGS);
      renderUi(<AiToolsStep guided onObserved={vi.fn()} />, {
        fixtures: {
          ...fx,
          setup_check: ({ actionId }: Record<string, unknown>) =>
            actionId === `status.${tool}` ? (n++ === 0 ? unknown : status[tool]) : status.claude,
        },
      });
      const label = tool === "claude" ? "Claude Code" : "Codex";
      const ready = tool === "claude" ? "Ready. Signed in with Claude Max." : "Ready. Signed in with ChatGPT.";
      // Checking meanwhile, never the unsure words.
      await waitFor(() => expect(rowOf(label).textContent).toContain("Checking whether you're signed in"));
      await waitFor(() => expect(rowOf(label).textContent).toContain(ready), { timeout: 5000 });
      expect(rowOf(label).textContent).not.toContain("couldn't tell");
      expect(tauri().callsOf("setup_check").filter((c) => c.args.actionId === `status.${tool}`)).toHaveLength(2);
    },
    15000,
  );

  it("Codex only: Codex builds and synthesizes, and says so", async () => {
    status = { claude: max, codex: chatgpt };
    await step({ tools: [git, claude(false), codex(true)] });
    await waitFor(() => expect(rowOf("Codex").textContent).toContain("Ready. Signed in with ChatGPT."));
    expect(screen.getByText("Codex will build and review your cards.")).toBeTruthy();
    await waitFor(() =>
      expect(savedBehavior()).toMatchObject({ builderVendor: "codex", discussionSynthesizer: "codex" }),
    );
    // The question is gone once one is installed; the other is a plain row.
    expect(screen.queryByRole("group", { name: "Which do you have?" })).toBeNull();
    expect(rowOf("Claude Code").textContent).toContain("Not installed.");
  });

  it("Claude only after Codex was the Builder: Claude takes both roles back", async () => {
    status = { claude: max, codex: chatgpt };
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      behavior: { ...DEFAULT_SETTINGS.behavior, builderVendor: "codex", discussionSynthesizer: "codex" },
    };
    await step({ tools: [git, claude(true), codex(false)], settings });
    await waitFor(() => expect(savedBehavior()).toMatchObject({ builderVendor: "claude", discussionSynthesizer: "claude" }));
  });

  // 1.171.0 (K7, Challenger 2): a Builder remembered from a card that isn't
  // there any more is switched too, and forgotten.
  it("Claude only with Codex remembered from a card: the remembered one is forgotten", async () => {
    status = { claude: max, codex: chatgpt };
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      behavior: { ...DEFAULT_SETTINGS.behavior, builderVendor: "claude", discussionSynthesizer: "claude", lastBuilderVendor: "codex" },
    };
    await step({ tools: [git, claude(true), codex(false)], settings });
    await waitFor(() =>
      expect(savedBehavior()).toMatchObject({ builderVendor: "claude", discussionSynthesizer: "claude", lastBuilderVendor: null }),
    );
  });

  it("both ready: Who builds your cards writes builderVendor", async () => {
    status = { claude: max, codex: chatgpt };
    const { user } = await step({ tools: [git, claude(true), codex(true)] });
    await waitFor(() => expect(screen.getByRole("group", { name: "Who builds your cards" })).toBeTruthy());
    expect(screen.getByText("The other one reviews the work. You can change it on any card.")).toBeTruthy();
    expect(tauri().callsOf("settings_set")).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Codex" }));
    await waitFor(() => expect(savedBehavior()?.builderVendor).toBe("codex"));
  });

  it("a newer release is a quiet Update with its own sheet (D6), never forced", async () => {
    status = { claude: max, codex: chatgpt };
    const { user } = await step({
      tools: [git, claude(true, { update: { latest: "2.1.290", detail: "", command: "claude update" } }), codex(false)],
    });
    await waitFor(() =>
      expect(rowOf("Claude Code").textContent).toContain("Ready. Signed in with Claude Max. Version 2.1.290 is available."),
    );
    const update = within(rowOf("Claude Code")).getByRole("button", { name: "Update" });
    expect(update.className).toMatch(/quiet/);
    await user.click(update);
    const sheet = screen.getByRole("dialog", { name: "Update Claude Code?" });
    expect(sheet.textContent).toContain("Plyloft will run Claude Code's own updater.");
    expect(within(sheet).getByText("claude update")).toBeTruthy();
    await user.click(within(sheet).getByRole("button", { name: "Update" }));
    await waitFor(() => expect(tauri().callsOf("setup_run")[0]?.args.actionId).toBe("update.claude"));
  });

  it("1.176.0 R2: an update refused with the old version answering says why and that it still works", async () => {
    status = { claude: max, codex: chatgpt };
    const { user } = await step({
      tools: [git, claude(true, { update: { latest: "2.1.290", detail: "", command: "claude update" } }), codex(false)],
    });
    await user.click(await waitFor(() => within(rowOf("Claude Code")).getByRole("button", { name: "Update" })));
    await user.click(within(screen.getByRole("dialog", { name: "Update Claude Code?" })).getByRole("button", { name: "Update" }));
    await waitFor(() => expect(tauri().callsOf("setup_run")).toHaveLength(1));
    emit(started("update.claude"), {
      phase: "done",
      outcome: "still-on-old-version",
      exitCode: 243,
      reprobed: true,
      tail: ["npm error code EACCES", "npm error path /usr/local/lib/node_modules/@anthropic-ai"],
      cause: "permissions",
      causePath: "/usr/local/lib/node_modules",
      versionBefore: "2.1.283",
      versionAfter: "2.1.283",
    });
    await waitFor(() => expect(screen.getByText("Claude Code wasn't updated.")).toBeTruthy());
    expect(
      screen.getByText("The computer didn't let Claude Code's updater change the folder /usr/local/lib/node_modules."),
    ).toBeTruthy();
    expect(screen.getByText("Claude Code still works, on version 2.1.283.")).toBeTruthy();
    expect(screen.getByText(/Ask whoever manages this computer, or install it yourself\./)).toBeTruthy();
    expect(screen.queryByText("Try again, or install it yourself.")).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    // 1.176.0 R6: and Repair, beside the block's own ways out.
    await user.click(screen.getByRole("button", { name: "Repair" }));
    expect(useRepair.getState().open).toBe(true);
    expect(useRepair.getState().tool).toBe("claude");
  });

  it("1.176.0 R6: an install that ended without the tool working shows a block with Repair; Reinstall opens Repair", async () => {
    status = { claude: max, codex: chatgpt };
    const { user } = await step({ tools: [git, claude(false), codex(true, { versionOk: false })] });
    // The Codex row's Reinstall is the guided Repair, not a consent sheet.
    await user.click(within(rowOf("Codex")).getByRole("button", { name: "Reinstall" }));
    expect(screen.queryByRole("dialog", { name: /Reinstall/ })).toBeNull();
    expect(useRepair.getState().tool).toBe("codex");
    act(() => useRepair.getState().dismiss());
    await user.click(within(rowOf("Claude Code")).getByRole("button", { name: "Install" }));
    await user.click(within(screen.getByRole("dialog", { name: /Install Claude Code/ })).getByRole("button", { name: "Install" }));
    await waitFor(() => expect(tauri().callsOf("setup_run")).toHaveLength(1));
    emit(started("install.claude"), { phase: "done", outcome: "not-observed", exitCode: 0, reprobed: true, tail: [] });
    await waitFor(() => expect(screen.getByText("Claude Code doesn't start yet.")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "Repair" }));
    expect(useRepair.getState().tool).toBe("claude");
  });

  it("too old: Update; Codex not starting: Reinstall", async () => {
    status = { claude: max, codex: chatgpt };
    await step({ tools: [git, claude(true, { versionOk: false }), codex(true, { versionOk: false })] });
    expect(rowOf("Claude Code").textContent).toContain("Installed but too old. Update it to use it with Plyloft.");
    expect(rowOf("Codex").textContent).toContain("Installed but not starting. Reinstall it.");
    expect(within(rowOf("Codex")).getByRole("button", { name: "Reinstall" })).toBeTruthy();
    expect(tauri().callsOf("setup_check")).toEqual([]);
  });

  // 1.176.0 R3: a Claude that doesn't answer `--version` gets Codex's row and
  // its Reinstall, not "too old" and `claude update`.
  it("Claude not starting: Reinstall, like Codex", async () => {
    status = { claude: max, codex: chatgpt };
    await step({ tools: [git, claude(true, { versionOk: false, version: null }), codex(true)] });
    expect(rowOf("Claude Code").textContent).toContain("Installed but not starting. Reinstall it.");
    expect(within(rowOf("Claude Code")).getByRole("button", { name: "Reinstall" })).toBeTruthy();
  });
});

describe("on Windows", () => {
  it("Claude Code without Git Bash: Install Git for Windows first → Install both runs git, then Claude", async () => {
    setPlatformForTests("windows");
    const { user } = await step({
      tools: [
        git,
        { id: "git-bash", found: false, versionOk: false, installCmd: "winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements" },
        claude(false, { installCmd: "irm https://claude.ai/install.ps1 | iex" }),
        codex(false, { installCmd: "irm https://chatgpt.com/codex/install.ps1 | iex" }),
      ],
    });
    await user.click(within(rowOf("Claude Code")).getByRole("button", { name: "Install" }));
    const sheet = screen.getByRole("dialog", { name: "Install Git for Windows first?" });
    expect(sheet.textContent).toContain("Claude Code on Windows needs Git for Windows. Windows may ask for an administrator's permission.");
    expect(within(sheet).getByText(/winget install --id Git\.Git/)).toBeTruthy();
    expect(within(sheet).getByText("irm https://claude.ai/install.ps1 | iex")).toBeTruthy();
    await user.click(within(sheet).getByRole("button", { name: "Install both" }));
    await waitFor(() => expect(tauri().callsOf("setup_run")[0]?.args.actionId).toBe("install.git"));
    emit(started("install.git"), { phase: "done", outcome: "succeeded", exitCode: 0, reprobed: true });
    await waitFor(() => expect(tauri().callsOf("setup_run")[1]?.args.actionId).toBe("install.claude"));
  });

  it("Git for Windows refused for want of an administrator: the admin block, and Claude does not start", async () => {
    setPlatformForTests("windows");
    const { user } = await step({
      tools: [git, { id: "git-bash", found: false, versionOk: false, installCmd: "winget …" }, claude(false), codex(false)],
    });
    await user.click(within(rowOf("Claude Code")).getByRole("button", { name: "Install" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Install both" }));
    await waitFor(() => expect(tauri().callsOf("setup_run")).toHaveLength(1));
    emit(started("install.git"), { phase: "done", outcome: "failed", exitCode: 0x8a150019 | 0 });
    expect(screen.getByText("Windows needs an administrator to install Git for Windows.")).toBeTruthy();
    expect(screen.getByText("Ask your IT team to install it, or install it yourself and press Look again.")).toBeTruthy();
    await nextFrame();
    expect(tauri().callsOf("setup_run")).toHaveLength(1);
  });

  it("winget missing: the refusal becomes Do it yourself · Look again", async () => {
    setPlatformForTests("windows");
    const { user } = await step({
      tools: [git, { id: "git-bash", found: false, versionOk: false, installCmd: "winget …" }, claude(false), codex(false)],
    });
    tauri().fixture("setup_run", () => {
      throw "Windows' package installer (winget) isn't available on this PC.";
    });
    await user.click(within(rowOf("Claude Code")).getByRole("button", { name: "Install" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Install both" }));
    await waitFor(() => expect(screen.getByText("Windows' package installer isn't available here.")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "Do it yourself" }));
    expect(tauri().callsOf("setup_open_page")[0].args).toEqual({ page: "install-git-windows" });
  });

  it("Codex installs with OpenAI's install.ps1 — Install Codex?, no Node.js sheet", async () => {
    setPlatformForTests("windows");
    const { user } = await step({
      tools: [git, claude(false), codex(false, { installCmd: "irm https://chatgpt.com/codex/install.ps1 | iex" })],
    });
    await user.click(within(rowOf("Codex")).getByRole("button", { name: "Install" }));
    const sheet = screen.getByRole("dialog", { name: "Install Codex?" });
    expect(within(sheet).getByText("irm https://chatgpt.com/codex/install.ps1 | iex")).toBeTruthy();
    expect(sheet.textContent).not.toMatch(/Node/);
    await user.click(within(sheet).getByRole("button", { name: "Install" }));
    await waitFor(() => expect(tauri().callsOf("setup_run")[0]?.args.actionId).toBe("install.codex"));
  });
});

describe("the sign-in reads run in the AI step only (D2, D4)", () => {
  it("in source: only SetupAiStep calls setupCheck, and only ipc.ts names setup_check", () => {
    const root = join(__dirname, "..");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !p.includes(`${join("src", "test")}`)) files.push(p);
      }
    };
    walk(root);
    const calling = files.filter((f) => /\bsetupCheck\s*\(/.test(readFileSync(f, "utf8"))).map((f) => relative(root, f).split(sep).join("/"));
    expect(calling.sort()).toEqual(["components/SetupAiStep.tsx", "ipc.ts"]);
    const naming = files.filter((f) => readFileSync(f, "utf8").includes("setup_check")).map((f) => relative(root, f).split(sep).join("/"));
    expect(naming).toEqual(["ipc.ts"]);
  });

  it("in Setup: another step runs no read; the AI step runs one per installed tool", async () => {
    tools = [git, claude(true), codex(true)];
    status = { claude: max, codex: chatgpt };
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      onboarding: { ...DEFAULT_SETTINGS.onboarding, level: "guided", currentStep: "mode" },
    };
    act(() => {
      useSettings.setState({ settings, loaded: true });
      useWorkspaces.setState({ workspaces: [], activeId: null });
      useSetup.setState({ open: true, setupCase: "existing" });
    });
    const { __settings: _, ...fx } = fixtures(settings);
    const { user } = renderUi(<SetupOverlay />, {
      fixtures: {
        ...fx,
        team_work_mode: { mode: "solo", chosen: false },
        team_status: { teamRepo: null, teamName: null, hasClone: false },
        project_config_list: [],
        // 1.175.0 F1/F2: a resume point on Solo or team reopens on the first
        // step not settled after the account — GitHub, which reads its own.
        setup_github_status: { ghFound: true, accounts: [], helper: "none", githubEmail: null, githubNoreply: null, sso: null },
      },
    });
    await nextFrame();
    expect(document.querySelector(".ux-setup-steptitle")?.textContent).toBe("Connect GitHub for your projects");
    expect(tauri().callsOf("setup_check")).toEqual([]);
    await user.click(within(screen.getByRole("navigation", { name: "Setup steps" })).getByRole("button", { name: /Your AI/ }));
    await waitFor(() => expect(document.querySelector(".ux-setup-steptitle")?.textContent).toBe("Your AI"));
    await waitFor(() => expect(tauri().callsOf("setup_check")).toHaveLength(2));
    expect(tauri().callsOf("setup_check").map((c) => c.args.actionId).sort()).toEqual(["status.claude", "status.codex"]);
    // Both ready: Continue is on.
    await waitFor(() => expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(false));
  });

  it("the step's own read decides Continue: a Claude the doctor found but that is signed out keeps it off", async () => {
    tools = [git, claude(true), codex(false)];
    status = { claude: signedOut, codex: chatgpt };
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      onboarding: { ...DEFAULT_SETTINGS.onboarding, level: "guided", currentStep: "ai" },
    };
    act(() => {
      useSettings.setState({ settings, loaded: true });
      useWorkspaces.setState({ workspaces: [], activeId: null });
      useSetup.setState({ open: true, setupCase: "existing" });
    });
    const { __settings: _, ...fx } = fixtures(settings);
    renderUi(<SetupOverlay />, {
      fixtures: {
        ...fx,
        // The doctor alone would call Claude ready (credential presence).
        dependency_doctor: () => ({ tools, allRequiredOk: true, aiReady: true }),
        team_work_mode: { mode: "solo", chosen: false },
        team_status: { teamRepo: null, teamName: null, hasClone: false },
        project_config_list: [],
      },
    });
    await waitFor(() => expect(rowOf("Claude Code").textContent).toContain("Installed. Not signed in yet."));
    expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Skip for now" })).toBeTruthy();
  });

  it("the fast path's checklist AI row starts the step's own action there", async () => {
    tools = [git, claude(false), codex(true)];
    status = { claude: max, codex: signedOut };
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      onboarding: { ...DEFAULT_SETTINGS.onboarding, level: "fast" },
    };
    act(() => {
      useSettings.setState({ settings, loaded: true });
      useWorkspaces.setState({ workspaces: [], activeId: null });
      useSetup.setState({ open: true, setupCase: "rerun" });
    });
    const { __settings: _, ...fx } = fixtures(settings);
    const { user } = renderUi(<SetupOverlay />, {
      fixtures: {
        ...fx,
        dependency_doctor: () => ({ tools, allRequiredOk: false, aiReady: false }),
        team_work_mode: { mode: "solo", chosen: false },
        team_status: { teamRepo: null, teamName: null, hasClone: false },
        project_config_list: [],
      },
    });
    await waitFor(() => expect(document.querySelector(".ux-setup-steptitle")?.textContent).toBe("Just the essentials"));
    const list = screen.getByRole("group", { name: "Setup checklist" });
    // No read from the checklist itself (D2, D4).
    expect(tauri().callsOf("setup_check")).toEqual([]);
    await user.click(within(list).getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(document.querySelector(".ux-setup-steptitle")?.textContent).toBe("Your AI"));
    await waitFor(() => expect(tauri().callsOf("setup_run")[0]?.args.actionId).toBe("login.codex"));
  });
});

// ── Challenger review of fd97671d ────────────────────────────────────────

async function overlayAt(settings: Settings, doctor?: () => unknown) {
  act(() => {
    useSettings.setState({ settings, loaded: true });
    useWorkspaces.setState({ workspaces: [], activeId: null });
    useSetup.setState({ open: true, setupCase: "existing" });
  });
  const { __settings: _, ...fx } = fixtures(settings);
  const r = renderUi(<SetupOverlay />, {
    fixtures: {
      ...fx,
      ...(doctor ? { dependency_doctor: doctor } : {}),
      team_work_mode: { mode: "solo", chosen: false },
      team_status: { teamRepo: null, teamName: null, hasClone: false },
      project_config_list: [],
    },
  });
  await nextFrame();
  return r;
}
const atAi: Settings = {
  ...DEFAULT_SETTINGS,
  onboarding: { ...DEFAULT_SETTINGS.onboarding, level: "guided", currentStep: "ai" },
};
const title = () => document.querySelector(".ux-setup-steptitle")?.textContent;

describe("leaving the step while it runs (review P2-1)", () => {
  it("every way out asks Stop the installer?; Keep going stays; Stop stops and goes", async () => {
    tools = [git, claude(false), codex(false)];
    const { user } = await overlayAt(atAi);
    await user.click(within(rowOf("Claude Code")).getByRole("button", { name: "Install" }));
    await user.click(within(screen.getByRole("dialog", { name: "Install Claude Code?" })).getByRole("button", { name: "Install" }));
    await waitFor(() => expect(tauri().callsOf("setup_run")).toHaveLength(1));

    for (const way of [
      () => screen.getByRole("button", { name: "Back" }),
      () => screen.getByRole("button", { name: "Skip for now" }),
      () => screen.getByRole("button", { name: "Close setup" }),
      () => screen.getByRole("button", { name: "Switch to just the essentials" }),
      () => within(screen.getByRole("navigation", { name: "Setup steps" })).getByRole("button", { name: /Git and your name/ }),
    ]) {
      await user.click(way());
      const sheet = screen.getByRole("dialog", { name: "Stop the installer?" });
      await user.click(within(sheet).getByRole("button", { name: "Keep going" }));
      expect(screen.queryByRole("dialog", { name: "Stop the installer?" })).toBeNull();
      expect(title()).toBe("Your AI");
    }
    expect(tauri().callsOf("setup_stop")).toEqual([]);
    expect(tauri().callsOf("settings_set").some((c) => typeof (c.args.settings as Settings).onboarding.skipped?.ai === "string")).toBe(false);

    // 1.175.0 F2: Back goes to GitHub (Solo or team isn't in the list).
    tauri().fixture("setup_github_status", { ghFound: true, accounts: [], helper: "none", githubEmail: null, githubNoreply: null, sso: null });
    await user.click(screen.getByRole("button", { name: "Back" }));
    await user.click(within(screen.getByRole("dialog", { name: "Stop the installer?" })).getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(title()).toBe("Connect GitHub for your projects"));
    expect(tauri().callsOf("setup_stop")[0].args).toEqual({ runId: "run-install.claude-1" });
  });

  it("a sign-in asks Stop signing in?, and Continue stays off while it runs even when the doctor says ready", async () => {
    tools = [git, claude(true), codex(false)];
    status = { claude: signedOut, codex: chatgpt };
    const { user } = await overlayAt(atAi, () => ({ tools, allRequiredOk: true, aiReady: true }));
    await waitFor(() => expect(rowOf("Claude Code").textContent).toContain("Not signed in yet."));
    await user.click(within(rowOf("Claude Code")).getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(tauri().callsOf("setup_run")).toHaveLength(1));
    // The step's reads are out while it runs; the doctor's `aiReady` must
    // not turn Continue on meanwhile.
    expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Close setup" }));
    const sheet = screen.getByRole("dialog", { name: "Stop signing in?" });
    await user.click(within(sheet).getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(useSetup.getState().open).toBe(false));
    expect(tauri().callsOf("setup_stop")).toHaveLength(1);
  });

  it("Install both survives the step unmounting: Claude Code starts after Git for Windows", async () => {
    setPlatformForTests("windows");
    const gitBashMissing = { id: "git-bash", found: false, versionOk: false, installCmd: "winget …" };
    const { user, unmount } = await step({ tools: [git, gitBashMissing, claude(false), codex(false)] });
    await user.click(within(rowOf("Claude Code")).getByRole("button", { name: "Install" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Install both" }));
    await waitFor(() => expect(tauri().callsOf("setup_run")).toHaveLength(1));
    unmount();
    emit(started("install.git"), { phase: "done", outcome: "succeeded", reprobed: true });
    await waitFor(() => expect(tauri().callsOf("setup_run")[1]?.args.actionId).toBe("install.claude"));
    expect(tauri().callsOf("setup_reach").map((c) => c.args.actionId)).toEqual(["install.claude"]);
  });
});

describe("Install both, the second half (review P3-1, P3-4)", () => {
  const gitBashMissing = { id: "git-bash", found: false, versionOk: false, installCmd: "winget …" };

  it("a Git for Windows that succeeds before setup_run answers still starts Claude Code", async () => {
    setPlatformForTests("windows");
    const { user } = await step({ tools: [git, gitBashMissing, claude(false), codex(false)] });
    let n = 0;
    tauri().fixture("setup_run", ({ actionId }: Record<string, unknown>) => {
      const run = started(actionId as SetupStarted["actionId"], ++n);
      tauri().emit("setup://progress", progress(run, {}));
      if (actionId === "install.git") {
        tauri().emit("setup://progress", progress(run, { phase: "done", outcome: "succeeded", exitCode: 0 }));
      }
      return run;
    });
    await user.click(within(rowOf("Claude Code")).getByRole("button", { name: "Install" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Install both" }));
    await waitFor(() => expect(tauri().callsOf("setup_run").map((c) => c.args.actionId)).toEqual(["install.git", "install.claude"]));
  });

  it("Git not ready: says why Claude Code wasn't installed; Try again resumes the pair", async () => {
    setPlatformForTests("windows");
    const { user } = await step({ tools: [git, gitBashMissing, claude(false), codex(false)] });
    await user.click(within(rowOf("Claude Code")).getByRole("button", { name: "Install" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Install both" }));
    await waitFor(() => expect(tauri().callsOf("setup_run")).toHaveLength(1));
    emit(started("install.git"), { phase: "done", outcome: "not-observed", exitCode: 0, reprobed: true });
    expect(screen.getByText("Claude Code wasn't installed because Git for Windows isn't ready yet.")).toBeTruthy();
    await nextFrame();
    expect(tauri().callsOf("setup_run")).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(tauri().callsOf("setup_run")).toHaveLength(2));
    expect(tauri().callsOf("setup_run")[1].args.actionId).toBe("install.git");
    emit(started("install.git", 2), { phase: "done", outcome: "succeeded", exitCode: 0 });
    await waitFor(() => expect(tauri().callsOf("setup_run")[2]?.args.actionId).toBe("install.claude"));
  });

  it("Git failed: Try again resumes the pair too", async () => {
    setPlatformForTests("windows");
    const { user } = await step({ tools: [git, gitBashMissing, claude(false), codex(false)] });
    await user.click(within(rowOf("Claude Code")).getByRole("button", { name: "Install" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Install both" }));
    await waitFor(() => expect(tauri().callsOf("setup_run")).toHaveLength(1));
    emit(started("install.git"), { phase: "done", outcome: "failed", exitCode: 1 });
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(tauri().callsOf("setup_run")).toHaveLength(2));
    emit(started("install.git", 2), { phase: "done", outcome: "succeeded", exitCode: 0 });
    await waitFor(() => expect(tauri().callsOf("setup_run")[2]?.args.actionId).toBe("install.claude"));
  });
});

describe("the Builder is never moved behind the person's back (review P3-2)", () => {
  it("an existing Codex Builder whose Codex reads broken stays Codex", async () => {
    status = { claude: max, codex: chatgpt };
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      behavior: { ...DEFAULT_SETTINGS.behavior, builderVendor: "codex", discussionSynthesizer: "codex" },
    };
    await step({ tools: [git, claude(true), codex(true, { versionOk: false })], settings });
    await waitFor(() => expect(rowOf("Claude Code").textContent).toContain("Ready. Signed in with Claude Max."));
    await nextFrame();
    expect(tauri().callsOf("settings_set")).toEqual([]);
  });

  it("a switch says so, and both turning ready in the same visit puts the choice back", async () => {
    status = { claude: signedOut, codex: chatgpt };
    const { user } = await step({ tools: [git, claude(true), codex(true)] });
    await waitFor(() => expect(savedBehavior()).toMatchObject({ builderVendor: "codex", discussionSynthesizer: "codex" }));
    act(() => useSettings.setState({ settings: { ...DEFAULT_SETTINGS, behavior: savedBehavior()! } }));
    expect(screen.getByText(/Plyloft switched who builds your cards from Claude to Codex\./)).toBeTruthy();

    await user.click(within(rowOf("Claude Code")).getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(tauri().callsOf("setup_run")).toHaveLength(1));
    status = { ...status, claude: max };
    emit(started("login.claude"), { phase: "done", outcome: "succeeded" });
    await waitFor(() => expect(savedBehavior()).toMatchObject({ builderVendor: "claude", discussionSynthesizer: "claude" }));
  });

  it("putting the choice back keeps the Builder remembered from a card (K7)", async () => {
    status = { claude: signedOut, codex: chatgpt };
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      behavior: { ...DEFAULT_SETTINGS.behavior, lastBuilderVendor: "claude" },
    };
    const { user } = await step({ tools: [git, claude(true), codex(true)], settings });
    await waitFor(() => expect(savedBehavior()).toMatchObject({ builderVendor: "codex", lastBuilderVendor: null }));
    act(() => useSettings.setState({ settings: { ...DEFAULT_SETTINGS, behavior: savedBehavior()! } }));
    await user.click(within(rowOf("Claude Code")).getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(tauri().callsOf("setup_run")).toHaveLength(1));
    status = { ...status, claude: max };
    emit(started("login.claude"), { phase: "done", outcome: "succeeded" });
    await waitFor(() => expect(savedBehavior()).toMatchObject({ builderVendor: "claude", lastBuilderVendor: "claude" }));
  });
});

// ── Claude's review folder (v1.164.0 part 5, "it becomes a Setup step too") ──
// Claude asks once whether to trust the folder Plyloft runs its reviews in.
// The step offers to open Claude there, in Setup's own terminal (a first run
// has no workspace for a tile); Plyloft never answers, never waits on it.

describe("Claude's review folder in the AI step", () => {
  const TRUST_TITLE = "Claude needs to trust Plyloft's review folder.";
  const untrusted = () => {
    reviewTrust = { folder: REVIEW_FOLDER, trusted: false };
  };
  const restore = () => {
    reviewTrust = { folder: REVIEW_FOLDER, trusted: true };
  };

  it("Claude Ready and the folder untrusted: Open Claude there runs trust.claude; Plyloft closes it once trusted", async () => {
    status = { claude: max, codex: chatgpt };
    untrusted();
    try {
      const { user, observed } = await step({ tools: [git, claude(true), codex(false)] });
      await waitFor(() => expect(rowOf("Claude Code").textContent).toContain("Ready. Signed in with Claude Max."));
      expect(await screen.findByText(TRUST_TITLE)).toBeTruthy();
      expect(screen.getByText(/Plyloft never answers that for you/)).toBeTruthy();
      expect(screen.getByText(REVIEW_FOLDER)).toBeTruthy();
      // Never part of the step's readiness.
      expect(lastObserved(observed)).toBe(true);

      await user.click(screen.getByRole("button", { name: "Open Claude there" }));
      await waitFor(() => expect(tauri().callsOf("setup_run")).toHaveLength(1));
      // Only the id crosses; Rust picks the folder.
      expect(tauri().callsOf("setup_run")[0].args).toEqual({ actionId: "trust.claude", args: null, cols: null, rows: null });
      expect(await screen.findByText("Choose “Yes, I trust this folder” below. Plyloft notices and closes Claude.")).toBeTruthy();
      expect(screen.queryByText(TRUST_TITLE)).toBeNull();
      // The Claude row is untouched by the run.
      expect(rowOf("Claude Code").textContent).toContain("Ready. Signed in with Claude Max.");
      expect(lastObserved(observed)).toBe(true);

      // The member answered in Claude; Rust saw Claude's state and closed it.
      restore();
      emit(started("trust.claude"), { phase: "done", outcome: "succeeded" });
      expect(await screen.findByText("Claude trusts Plyloft's review folder.")).toBeTruthy();
      await waitFor(() => expect(tauri().callsOf("claude_review_trust_status").length).toBeGreaterThanOrEqual(2));
      expect(screen.queryByText(TRUST_TITLE)).toBeNull();
      // Nothing else ran: no sign-in read again, no reviewer proof.
      expect(tauri().callsOf("reviewer_capability_probe")).toEqual([]);
    } finally {
      restore();
    }
  });

  it("Claude closed with the folder still untrusted: the step comes back", async () => {
    status = { claude: max, codex: chatgpt };
    untrusted();
    try {
      const { user } = await step({ tools: [git, claude(true), codex(false)] });
      await user.click(await screen.findByRole("button", { name: "Open Claude there" }));
      await waitFor(() => expect(tauri().callsOf("setup_run")).toHaveLength(1));
      emit(started("trust.claude"), { phase: "done", outcome: "not-observed", exitCode: 0 });
      expect(await screen.findByText("Claude doesn't trust Plyloft's review folder yet.")).toBeTruthy();
      expect(await screen.findByText(TRUST_TITLE)).toBeTruthy();
    } finally {
      restore();
    }
  });

  const pane = () => document.querySelector("[data-ply-setup-pty-id]");

  it.each(["succeeded", "not-observed", "cancelled"] as const)(
    "once the trust run has ended (%s), only its line is left: no empty terminal",
    async (outcome) => {
      status = { claude: max, codex: chatgpt };
      untrusted();
      try {
        const { user } = await step({ tools: [git, claude(true), codex(false)] });
        await user.click(await screen.findByRole("button", { name: "Open Claude there" }));
        await waitFor(() => expect(pane()).not.toBeNull());
        if (outcome === "succeeded") restore();
        emit(started("trust.claude"), { phase: "done", outcome, exitCode: outcome === "succeeded" ? null : 0 });
        await waitFor(() => expect(pane()).toBeNull());
        expect(document.querySelector("[data-ply-setup-terminal]")?.textContent).not.toContain("Details");
        const words = {
          succeeded: "Claude trusts Plyloft's review folder.",
          "not-observed": "Claude doesn't trust Plyloft's review folder yet.",
          cancelled: "Stopped. Claude doesn't trust the folder yet.",
        }[outcome];
        expect(screen.getByText(words)).toBeTruthy();
      } finally {
        restore();
      }
    },
  );

  it("a sign-in's terminal still stays for reading after it ends (unchanged)", async () => {
    status = { claude: signedOut, codex: chatgpt };
    const { user } = await step({ tools: [git, claude(true), codex(false)] });
    await waitFor(() => expect(rowOf("Claude Code").textContent).toContain("Not signed in yet."));
    await user.click(within(rowOf("Claude Code")).getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(pane()).not.toBeNull());
    emit(started("login.claude"), { phase: "done", outcome: "not-observed", exitCode: 1 });
    await waitFor(() => expect(screen.getByText("Not signed in yet.")).toBeTruthy());
    expect(pane()).not.toBeNull();
  });

  it("Later (reviews wait) puts it off for this visit", async () => {
    status = { claude: max, codex: chatgpt };
    untrusted();
    try {
      const { user } = await step({ tools: [git, claude(true), codex(false)] });
      await user.click(await screen.findByRole("button", { name: "Later (reviews wait)" }));
      expect(screen.queryByText(TRUST_TITLE)).toBeNull();
      expect(tauri().callsOf("setup_run")).toEqual([]);
    } finally {
      restore();
    }
  });

  it.each([
    ["trusted", max, true, true, "Ready. Signed in with Claude Max."],
    ["unreadable", max, null, true, "Ready. Signed in with Claude Max."],
    ["Claude signed out", signedOut, false, false, "Installed. Not signed in yet."],
    ["Codex only", max, false, false, null],
  ] as const)("%s: nothing drawn; Claude's state is read only once Claude is Ready", async (_why, answer, trusted, read, words) => {
    status = { claude: answer, codex: chatgpt };
    reviewTrust = { folder: REVIEW_FOLDER, trusted };
    try {
      const codexOnly = words === null;
      await step({ tools: codexOnly ? [git, claude(false), codex(true)] : [git, claude(true), codex(false)] });
      if (words) await waitFor(() => expect(rowOf("Claude Code").textContent).toContain(words));
      else await waitFor(() => expect(rowOf("Codex").textContent).toContain("Ready"));
      if (read) await waitFor(() => expect(tauri().callsOf("claude_review_trust_status").length).toBeGreaterThan(0));
      await nextFrame();
      expect(screen.queryByText(TRUST_TITLE)).toBeNull();
      if (!read) expect(tauri().callsOf("claude_review_trust_status")).toEqual([]);
    } finally {
      restore();
    }
  });

  it("Continue doesn't wait on Claude: it asks Stop Claude? and stops it", async () => {
    tools = [git, claude(true), codex(false)];
    status = { claude: max, codex: chatgpt };
    untrusted();
    try {
      const { user } = await overlayAt(atAi, () => ({ tools, allRequiredOk: true, aiReady: true }));
      await user.click(await screen.findByRole("button", { name: "Open Claude there" }));
      await waitFor(() => expect(tauri().callsOf("setup_run")).toHaveLength(1));
      const next = screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement;
      await waitFor(() => expect(next.disabled).toBe(false));
      await user.click(next);
      const sheet = screen.getByRole("dialog", { name: "Stop Claude?" });
      await user.click(within(sheet).getByRole("button", { name: "Stop" }));
      await waitFor(() => expect(tauri().callsOf("setup_stop")).toHaveLength(1));
      await waitFor(() => expect(title()).not.toBe("Your AI"));
      // The next step's own reads are not this test's.
      tauri().allowUnhandled();
    } finally {
      restore();
    }
  });
});

