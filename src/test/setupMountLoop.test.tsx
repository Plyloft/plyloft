// OB-4, Tier 1.5 (mount loop): Setup is drawn *over* the shell, never
// instead of it (ONBOARDING_SPEC §3.1, C11). Opening and closing it — and a
// launch that opens it for an existing user with terminals running (D1) —
// must not unmount a warmed workspace's hosts: unmounting disposes xterm and
// kills the PTY (AGENTS.md). The real App is rendered; only the terminal body
// is replaced by a probe that counts its mounts and unmounts, the way
// Terminal.tsx spawns on mount and kills on unmount.
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { useAccount } from "../store/accountStore";
import { useSetup } from "../store/setupStore";
import { useToasts } from "../store/toastStore";
import { setSetupAutoOpenForTests } from "../lib/setupSteps";
import { useTiles } from "../store/tileStore";
import { useUi } from "../store/uiStore";
import { useWorkMode } from "../store/workModeStore";
import { DEFAULT_SETTINGS, type Settings } from "../store/settingsStore";
import { SETUP_VERSION } from "../lib/settingsShape";
import type { AccountInfo } from "../ipc";
import type { Workspace } from "../store/workspaceStore";
import { act, nextFrame, renderUi, screen, waitFor } from "./render";

const life = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }));

vi.mock("../components/Terminal", () => ({
  Terminal: ({ tileId }: { tileId: string }) => {
    useEffect(() => {
      life.mounts += 1;
      return () => {
        life.unmounts += 1;
      };
    }, []);
    return <div data-testid="terminal" data-tile={tileId} />;
  },
}));
vi.mock("../components/CodexSession", () => ({ CodexSession: () => <div data-testid="codex" /> }));

// Before, not after: the harness unmounts the last test's tree after this
// file's own afterEach would run.
beforeEach(() => {
  life.mounts = 0;
  life.unmounts = 0;
  // The shipped constant (SETUP_AUTO_OPEN, on since OB-17): nothing is forced.
  setSetupAutoOpenForTests(null);
});
afterEach(() => setSetupAutoOpenForTests(null));

const lyra: Workspace = {
  id: "w1",
  name: "lyra",
  cwd: "/Users/someone/code/lyra",
  createdAt: 1,
  lastOpenedAt: 1,
  openFiles: [],
  activeFile: null,
};

/** A signed-in Free account. */
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
  lastKnownPlan: "free",
  team: null,
  deviceName: "Test Mac",
};
const SIGNED_OUT: AccountInfo = {
  ...SIGNED_IN,
  signedIn: false,
  login: null,
  sub: null,
  exp: null,
  entitlementValid: false,
  lastCheckedAt: null,
  lastKnownPlan: null,
};
/** This build's Setup, already seen: nothing opens by itself. */
const seen = (settings: Settings): Settings => ({
  ...settings,
  onboarding: { ...settings.onboarding, setupVersion: SETUP_VERSION },
});

/** An existing user upgrading: first run long done, no `setupVersion`. */
const upgrading: Settings = {
  ...DEFAULT_SETTINGS,
  onboarding: { ...DEFAULT_SETTINGS.onboarding, firstRunCompletedAt: "2026-01-01T00:00:00Z" },
};

/**
 * Launch the app on `settings`, with a shell running in lyra. The settings
 * answer is held back until the terminal is up, so Setup (which opens once
 * settings are loaded) comes up over a terminal that already runs — the
 * existing user's upgrade (D1).
 */
async function launch(
  settings: Settings,
  { welcome = false, account = SIGNED_IN }: { welcome?: boolean; account?: AccountInfo } = {},
) {
  const tauri = renderUi(<div />).tauri;
  tauri.allowUnhandled();
  let release: (s: Settings) => void = () => {};
  const held = new Promise<Settings>((resolve) => {
    release = resolve;
  });
  tauri.fixture("settings_get", () => held);
  tauri.fixture("settings_set", ({ settings: next }: Record<string, unknown>) => next);
  tauri.fixture("workspace_list", { workspaces: [lyra], activeWorkspaceId: lyra.id });
  tauri.fixture("workspace_cwd_exists", true);
  tauri.fixture("drain_status", { draining: false, startedAt: null });
  tauri.fixture("ship_pending_count", 0);
  tauri.fixture("ship_pending_cards", null);
  tauri.fixture("ship_unverified_count", 0);
  tauri.fixture("pty_spawn", "pty-1");
  // What the app reads at launch and when a workspace warms.
  tauri.fixture("agent_list", []);
  tauri.fixture("agent_run_list", []);
  tauri.fixture("kanban_load", []);
  tauri.fixture("swarm_list", []);
  tauri.fixture("inbox_feed", { generatedAt: 0, windowDays: 28, events: [], costRollup: [], eligibilityProof: {} });
  tauri.fixture("improvement_proposal_state", null);
  tauri.fixture("improvement_proposal_trust_stopped", null);
  tauri.fixture("onboarding_take_welcome", welcome);
  tauri.fixture("identity_get", null);
  // Launch A2: the account, read at launch (D1).
  tauri.fixture("account_get", account);
  tauri.fixture("account_dev_skip_sign_in", false);
  // What Setup reads when it opens.
  tauri.fixture("team_work_mode", { mode: "solo", chosen: false });
  tauri.fixture("team_status", { teamRepo: null, teamName: null, hasClone: false });
  tauri.fixture("project_config_list", []);
  tauri.fixture("dependency_doctor", {
    tools: [
      { id: "git", found: true, versionOk: true },
      { id: "claude", found: true, versionOk: true },
    ],
    allRequiredOk: true,
  });
  useUi.getState().setCenterMode(lyra.id, "terminals");
  const r = renderUi(<App />);
  // The workspace loads and warms; then a shell is opened in it.
  await screen.findByRole("button", { name: /lyra, switch workspace/ });
  await act(async () => {
    useTiles.getState().addShellTile(lyra.id, lyra.cwd);
  });
  await waitFor(() => expect(screen.getByTestId("terminal")).toBeTruthy());
  const running = screen.getByTestId("terminal");
  // Now the settings arrive, and with them the decision to open Setup.
  await act(async () => release(settings));
  await nextFrame();
  return { ...r, tauri, running };
}

const terminal = () => screen.getByTestId("terminal");
const gridHost = () => document.querySelector(".tile-grid-host");
const codeHost = () => document.querySelector(".center-mode-sticky");

describe("Setup over a running app", () => {
  it("opens once for an existing user over the shell, and the shell's hosts keep their identity", async () => {
    const { tauri, running } = await launch(upgrading);
    // Opened by itself (D1), over the terminal already running: same node.
    await screen.findByRole("dialog", { name: "Plyloft can now set itself up" });
    expect(useSetup.getState().open).toBe(true);
    const term = terminal();
    expect(term).toBe(running);
    const grid = gridHost();
    expect(grid).toBeTruthy();
    // The shell under Setup is inert and hidden from assistive tech.
    const under = document.querySelector(".app-shell-under") as HTMLElement;
    expect(under.contains(term)).toBe(true);
    expect(under.hasAttribute("inert")).toBe(true);
    expect(under.getAttribute("aria-hidden")).toBe("true");

    // Close setup: stamps the version, the shell comes back, same nodes.
    await act(async () => screen.getByRole("button", { name: "Close setup" }).click());
    await waitFor(() => expect(useSetup.getState().open).toBe(false));
    expect(screen.queryByRole("dialog", { name: /set itself up/ })).toBeNull();
    expect(terminal()).toBe(term);
    expect(gridHost()).toBe(grid);
    expect(under.hasAttribute("inert")).toBe(false);
    expect(under.hasAttribute("aria-hidden")).toBe(false);
    const saved = tauri.callsOf("settings_set").map((c) => (c.args.settings as Settings).onboarding);
    expect(saved[saved.length - 1]?.setupVersion).toBe(SETUP_VERSION);

    // Open and close again, several times: never a remount.
    for (let i = 0; i < 3; i++) {
      await act(async () => useSetup.getState().openSetup("rerun"));
      await screen.findByRole("dialog", { name: "Setup" });
      expect(terminal()).toBe(term);
      await act(async () => useSetup.getState().closeSetup());
      expect(terminal()).toBe(term);
      expect(gridHost()).toBe(grid);
    }
    expect(life.mounts).toBe(1);
    expect(life.unmounts).toBe(0);
    expect(tauri.callsOf("pty_kill")).toEqual([]);
  });

  it("keeps the Code host (the editor) mounted across Setup", async () => {
    const settings: Settings = seen(upgrading);
    await launch(settings);
    // Stamped: Setup does not open by itself.
    expect(useSetup.getState().open).toBe(false);
    await act(async () => useUi.getState().setCenterMode(lyra.id, "code"));
    await waitFor(() => expect(codeHost()).toBeTruthy());
    const code = codeHost();
    const term = terminal();
    await act(async () => useSetup.getState().openSetup("rerun"));
    await screen.findByRole("dialog", { name: "Setup" });
    expect(codeHost()).toBe(code);
    await act(async () => useSetup.getState().closeSetup());
    expect(codeHost()).toBe(code);
    expect(terminal()).toBe(term);
    expect(life.unmounts).toBe(0);
  });

  it("a fresh install opens Setup at step 1 over the shell", async () => {
    await launch(DEFAULT_SETTINGS);
    const dialog = await screen.findByRole("dialog", { name: "Set up Plyloft" });
    expect(dialog.textContent).toContain("Welcome to Plyloft");
    // The shell rendered underneath from the start: no early return.
    expect(document.querySelector(".ws-shell")).toBeTruthy();
    expect(terminal()).toBeTruthy();
  });

  it("with the automatic open off (SETUP_AUTO_OPEN), nothing opens at launch", async () => {
    setSetupAutoOpenForTests(false);
    await launch(upgrading);
    await nextFrame();
    expect(useSetup.getState().open).toBe(false);
    expect(screen.queryByRole("dialog", { name: /set itself up/ })).toBeNull();
  });

  it("gives focus back to where it was when Setup closes", async () => {
    const settings: Settings = seen(upgrading);
    await launch(settings);
    const trigger = screen.getByRole("button", { name: /lyra, switch workspace/ });
    act(() => trigger.focus());
    expect(document.activeElement).toBe(trigger);
    // A browser drops the focus of an element that turns inert; jsdom does
    // not, so the blur is done here, before Setup renders.
    await act(async () => {
      useSetup.getState().openSetup("rerun");
      trigger.blur();
    });
    await screen.findByRole("dialog", { name: "Setup" });
    // The dialog takes focus on its next frame.
    await nextFrame();
    expect(document.activeElement).not.toBe(trigger);
    await act(async () => useSetup.getState().closeSetup());
    await nextFrame();
    await nextFrame();
    expect(document.activeElement).toBe(trigger);
  });

  it("drops onboard.sh's welcome toast when Setup opened at launch", async () => {
    await launch(upgrading, { welcome: true });
    await screen.findByRole("dialog", { name: "Plyloft can now set itself up" });
    expect(useToasts.getState().toasts.map((t) => t.title)).not.toContain("Welcome — your workspaces are ready");
  });

  it("OB-9: turning Work with a team on and off never remounts a workspace host", async () => {
    const settings: Settings = seen(upgrading);
    const { tauri } = await launch(settings);
    // The backend answers the mode from what was saved, as Rust does.
    let mode: "solo" | "team" = "solo";
    tauri.fixture("team_work_mode", () => ({ mode, chosen: true }));
    tauri.fixture("settings_set", ({ settings: next }: Record<string, unknown>) => {
      const chosen = (next as Settings).team?.workMode;
      if (chosen) mode = chosen;
      return next;
    });
    await waitFor(() => expect(useWorkMode.getState().mode).toBe("solo"));
    const term = terminal();
    const grid = gridHost();
    act(() => {
      useUi.getState().setSettingsOverlayOpen(true);
      useUi.getState().openSettingsSection("setup");
    });
    await screen.findByRole("switch", { name: "Work with a team" });
    for (const next of ["team", "solo", "team", "solo"] as const) {
      await act(async () => screen.getByRole("switch", { name: "Work with a team" }).click());
      await waitFor(() => expect(useWorkMode.getState().mode).toBe(next));
      expect(terminal()).toBe(term);
      expect(gridHost()).toBe(grid);
    }
    expect(life.mounts).toBe(1);
    expect(life.unmounts).toBe(0);
    expect(tauri.callsOf("pty_kill")).toEqual([]);
  });

  it("shows onboard.sh's welcome toast when Setup did not open", async () => {
    const settings: Settings = seen(upgrading);
    await launch(settings, { welcome: true });
    await waitFor(() =>
      expect(useToasts.getState().toasts.map((t) => t.title)).toContain("Welcome — your workspaces are ready"),
    );
  });
});

// 1.178.0 (A3): signed out of Plyloft is an ordinary state — nothing covers
// the shell, shortcuts reach it, and a Setup-1 Mac is never reopened for the
// optional account step.
describe("signed out over a running app (A3)", () => {
  it("covers nothing while signed out; signing in changes nothing under it", async () => {
    const { tauri, running } = await launch(seen(upgrading), { account: SIGNED_OUT });
    await waitFor(() => expect(useAccount.getState().loaded).toBe(true));
    expect(screen.queryByRole("dialog", { name: "Sign in to Plyloft" })).toBeNull();
    expect(document.querySelector("[data-ply-signin]")).toBeNull();
    const under = document.querySelector(".app-shell-under") as HTMLElement;
    expect(under.hasAttribute("inert")).toBe(false);
    expect(under.getAttribute("aria-hidden")).toBeNull();
    expect(terminal()).toBe(running);
    const grid = gridHost();
    // A sign-in from Settings › Plan finishes: the same nodes, and the toast.
    await act(async () => tauri.emit("account://sign-in", { attempt: 1, state: "signed_in", info: SIGNED_IN }));
    expect(under.hasAttribute("inert")).toBe(false);
    expect(terminal()).toBe(running);
    expect(gridHost()).toBe(grid);
    expect(useToasts.getState().toasts.map((t) => t.title)).toContain("Signed in as octocat · Free");
    // The session ends (signed out by the server): still nothing covers it.
    await act(async () => tauri.emit("account://changed", { ...SIGNED_OUT, lastCheckedAt: 5 }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(under.hasAttribute("inert")).toBe(false);
    expect(terminal()).toBe(running);
    expect(life.mounts).toBe(1);
    expect(life.unmounts).toBe(0);
    expect(tauri.callsOf("pty_kill")).toEqual([]);
  });

  it("shortcuts reach the shell while signed out", async () => {
    await launch(seen(upgrading), { account: SIGNED_OUT });
    await waitFor(() => expect(useAccount.getState().loaded).toBe(true));
    const key = new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true });
    act(() => {
      window.dispatchEvent(key);
    });
    expect(useUi.getState().palette.open).toBe(true);
  });

  it("Setup closed without an account leaves the app as it is", async () => {
    await launch(DEFAULT_SETTINGS, { account: SIGNED_OUT });
    await screen.findByRole("dialog", { name: "Set up Plyloft" });
    await act(async () => screen.getByRole("button", { name: "Close setup" }).click());
    await waitFor(() => expect(useSetup.getState().open).toBe(false));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect((document.querySelector(".app-shell-under") as HTMLElement).hasAttribute("inert")).toBe(false);
    expect(terminal()).toBeTruthy();
    expect(life.unmounts).toBe(0);
  });

  it("D6: a Mac that saw Setup 1, signed out, is stamped silently; Setup does not open", async () => {
    const old: Settings = {
      ...upgrading,
      onboarding: { ...upgrading.onboarding, setupVersion: 1, level: "guided", currentStep: "ready" },
    };
    const { tauri } = await launch(old, { account: SIGNED_OUT });
    await waitFor(() => {
      const saved = tauri.callsOf("settings_set").map((c) => (c.args.settings as Settings).onboarding);
      expect(saved[saved.length - 1]?.setupVersion).toBe(SETUP_VERSION);
    });
    expect(useSetup.getState().open).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
    const saved = tauri.callsOf("settings_set").map((c) => (c.args.settings as Settings).onboarding);
    expect(saved[saved.length - 1]?.currentStep).toBe("ready");
  });
});

describe("launch A2 review", () => {
  it("P2-2: a Setup-1 Mac already signed in is stamped silently; Setup does not open", async () => {
    const old: Settings = {
      ...upgrading,
      onboarding: { ...upgrading.onboarding, setupVersion: 1, level: "guided", currentStep: "ready" },
    };
    const { tauri } = await launch(old, { account: SIGNED_IN });
    await waitFor(() => {
      const saved = tauri.callsOf("settings_set").map((c) => (c.args.settings as Settings).onboarding);
      expect(saved[saved.length - 1]?.setupVersion).toBe(SETUP_VERSION);
    });
    expect(useSetup.getState().open).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
    const saved = tauri.callsOf("settings_set").map((c) => (c.args.settings as Settings).onboarding);
    expect(saved[saved.length - 1]?.currentStep).toBe("ready");
  });
});


// Challenger block 5 (item 10): ⌘⇧N, from Terminals, opens the Board with
// its new-card field focused — and the running shell is never unmounted.
describe("⌘⇧N New card (QoL 1.168 block 5.4)", () => {
  it("opens the Board's new-card field from Terminals", async () => {
    const { running } = await launch(seen(DEFAULT_SETTINGS));
    expect(useUi.getState().centerMode[lyra.id]).toBe("terminals");
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "N", code: "KeyN", metaKey: true, shiftKey: true, bubbles: true }));
    });
    await waitFor(() => expect(useUi.getState().centerMode[lyra.id]).toBe("board"));
    // An empty Board: its one field, focused.
    const field = await screen.findByRole("textbox", { name: "What do you want to build?" });
    await waitFor(() => expect(document.activeElement).toBe(field));
    expect(terminal()).toBe(running);
    expect(life.unmounts).toBe(0);
  });
});
