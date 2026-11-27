// 2026-10-16 Tier 4 walk: with a Settings PATH override, Plyloft never asks
// the login shell (`shell_env::re_probe` applies the override), so Settings ›
// Diagnostics must not say it does. The real DiagnosticsPage, the real doctor
// and settings stores, the report through the stubbed `dependency_doctor`:
//
//  - no override: `Look again` asks the login shell, and a failed probe says
//    the login shell's answer came back unusable;
//  - an override and no AI tool: `Look again` looks in the PATH set in
//    Editor and terminals, and the error says neither claude nor codex is in
//    it — check it or clear it — without a word about the login shell.
import { setPlatformForTests } from "../lib/platform";
import { afterEach, describe, expect, it } from "vitest";
import { DiagnosticsPage } from "../components/settings/DiagnosticsPage";
import type { DoctorReport } from "../ipc";
import { DEFAULT_SETTINGS, useSettings, type Settings } from "../store/settingsStore";
import { act, renderUi, screen } from "./render";
import { useUi } from "../store/uiStore";

const OVERRIDE_ERROR =
  "Neither claude nor codex is in the PATH you set in Settings › Look and feel › Editor and terminals. Check that PATH, or clear it so Plyloft asks your login shell again.";

function report(probeError: string | null): DoctorReport {
  return {
    tools: [],
    teamSkills: null,
    projectSkills: null,
    microphone: null,
    whisperModel: null,
    dictationShell: null,
    sharedDefinition: null,
    probeError,
    allRequiredOk: false,
    aiReady: false,
    gitIdentity: null,
  };
}

async function open(
  pathOverride: string | null,
  r: DoctorReport,
  firstText: string | RegExp,
  problems: string[] = [],
) {
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    shell: { ...DEFAULT_SETTINGS.shell, pathOverride },
  };
  act(() => useSettings.setState({ settings, loaded: true }));
  renderUi(<DiagnosticsPage scope="this-mac" />, {
    fixtures: {
      dependency_doctor: () => r,
      build_cache_status: () => null,
      program_folders_check: () => ({ windows: false, problems }),
    },
  });
  await screen.findByText(firstText);
}

afterEach(() => {
  act(() => useSettings.setState({ settings: DEFAULT_SETTINGS }));
});

describe("Diagnostics says where Plyloft looks (PATH override)", () => {
  it("without an override it names the login shell", async () => {
    await open(null, report("Login shell probe (`zsh -l`) exited with status 127: boom"), /came back unusable/);
    expect(
      screen.getByText(
        "Plyloft asks your login shell all over again, instead of reading what it noted at startup.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Plyloft couldn't read this Mac's program folders.")).toBeTruthy();
    expect(
      screen.getByText(/It asked your login shell where your tools are and the answer came back unusable/),
    ).toBeTruthy();
  });

  it("with no override and only 'no AI tool found' there is no error box, just the rows", async () => {
    await open(
      null,
      report("No AI tool found. Install Claude Code or Codex, or set a PATH override in Settings › Look and feel › Editor and terminals."),
      "Something Plyloft cannot work without is missing — the rows below say which.",
    );
    expect(screen.queryByText("Plyloft couldn't read this Mac's program folders.")).toBeNull();
    expect(screen.queryByText("Ask again")).toBeNull();
  });

  it("with an override and no AI tool it names that PATH, never the login shell's answer", async () => {
    await open("/opt/tools/bin", report(OVERRIDE_ERROR), "Plyloft found no AI tool in the program folders you set.");
    expect(
      screen.getByText(
        "Plyloft looks again in the program folders you set in Editor and terminals, instead of reading what it noted at startup.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Plyloft looked only in the program folders you set in Editor and terminals, and neither claude nor codex is there.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Check those folders, or empty them so Plyloft asks your login shell again.")).toBeTruthy();
    expect(screen.queryByText(/It asked your login shell/)).toBeNull();
    expect(screen.queryByText(/asks your login shell all over again/)).toBeNull();
  });

  it("on Windows it names the folders Windows gave it, not a login shell", async () => {
    setPlatformForTests("windows");
    try {
      await open(null, report(null), /program folders Windows gave it and where these tools usually install/);
      expect(screen.queryByText(/login shell/)).toBeNull();
    } finally {
      setPlatformForTests(null);
    }
  });

  it("a blank override counts as none", async () => {
    await open("   ", report(null), "Plyloft asks your login shell all over again, instead of reading what it noted at startup.");
  });

  // 1.176.1: the owner's value — the warning says why, and opens the row.
  it("a saved value that can't work says why, and its button opens the Program folders row", async () => {
    await open("~/.local/bin/claude", report(OVERRIDE_ERROR), "Plyloft found no AI tool in the program folders you set.", [
      "namesAFile",
      "tilde",
    ]);
    expect(
      await screen.findByText(/They can't work as written: it names a file, not a folder and it is written with ~\./),
    ).toBeTruthy();
    act(() => screen.getByRole("button", { name: "Open Program folders" }).click());
    expect(useUi.getState().settingsSection).toBe("editor-terminals");
    expect(useUi.getState().settingsRow).toBe("Program folders");
  });

  // 1.176.1 walk: tools outside the folders set are never offered Install.
  it("tools missing under Program folders say so and offer the folders, never Install", async () => {
    const missingTool = (id: string, required: boolean) =>
      ({ id, name: id, found: false, required, version: null, versionOk: false, path: null, installCmd: `install ${id}`, detail: "Not installed.", docsUrl: "" }) as never;
    const r = { ...report(OVERRIDE_ERROR), tools: [missingTool("git", true), missingTool("gh", false)] };
    await open("/tmp/ply-walk-nothing-here", r, "Plyloft found no AI tool in the program folders you set.");
    expect(screen.getAllByText(/Not in your Program folders\./).length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Open Program folders" }).length).toBeGreaterThanOrEqual(2);
  });
});
