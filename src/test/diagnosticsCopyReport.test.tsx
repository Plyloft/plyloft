// 1.176.1: Settings › Diagnostics › Copy report — the whole page as one
// scrubbed plain-text report. The real page, doctor and settings stores; the
// backend through fixtures. A part that can't be read is said in its place.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DiagnosticsPage } from "../components/settings/DiagnosticsPage";
import type { DoctorReport, ToolStatus } from "../ipc";
import { useHelp } from "../store/helpStore";
import { DEFAULT_SETTINGS, useSettings } from "../store/settingsStore";
import { act, renderUi, screen, waitFor } from "./render";

beforeEach(() => {
  act(() => useHelp.setState({ version: "1.176.1" }));
});
afterEach(() => {
  act(() => useSettings.setState({ settings: DEFAULT_SETTINGS }));
});

function tool(id: string, patch: Partial<ToolStatus> = {}): ToolStatus {
  return {
    id, name: id, required: id === "git", found: true, path: `/Users/matteo/bin/${id}`, version: "1.0.0", versionOk: true,
    detail: "Nothing to do.", installCmd: "brew install x", docsUrl: "https://example.com", reviewer: null, ...patch,
  } as ToolStatus;
}
const report: DoctorReport = {
  tools: [tool("git"), tool("claude"), tool("codex", { found: false, versionOk: false, path: null, detail: "Not installed." }), tool("gh")],
  teamSkills: null, projectSkills: null, microphone: null, whisperModel: null, dictationShell: null, sharedDefinition: null,
  probeError: null, allRequiredOk: true, aiReady: true,
  gitIdentity: { set: true, name: "Ana", email: "ana@example.com", detail: "Git knows you as Ana <ana@example.com>." },
};

/** What the copy put on the clipboard (user-event's own clipboard). */
async function copied(): Promise<string> {
  let text = "";
  await waitFor(async () => {
    text = await navigator.clipboard.readText();
    expect(text).not.toBe("");
  });
  return text;
}

async function open(fixtures: Record<string, unknown> = {}, pathOverride: string | null = null) {
  act(() => useSettings.setState({ settings: { ...DEFAULT_SETTINGS, shell: { ...DEFAULT_SETTINGS.shell, pathOverride } }, loaded: true }));
  const view = renderUi(<DiagnosticsPage scope="this-mac" />, {
    fixtures: {
      dependency_doctor: () => report,
      build_cache_status: () => null,
      watchdog_status: () => null,
      program_folders_check: () => ({
        windows: false, entries: [], found: [], missing: ["claude"], basicsMissing: [], systemFoldersMissing: [], problems: ["namesAFile"],
      }),
      shell_env_info: () => ({ path: "/Users/matteo/.local/bin:/usr/bin" }),
      cli_repair_report: ({ tool: t }: { tool: string }) =>
        t === "claude" ? "Claude Code at /Users/matteo/.local/bin/claude\nsigned in with ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4" : "Codex: not installed",
      ...fixtures,
    },
  });
  await screen.findByText("Ready", {}, { timeout: 3000 }).catch(() => {});
  return view;
}

describe("Diagnostics › Copy report", () => {
  it("copies the page's rows, the folders and each tool's report, scrubbed, and the button says Copied", async () => {
    const view = await open();
    await view.user.click(screen.getByRole("button", { name: "Copy report" }));
    const text = await copied();
    expect(text).toMatch(/^Plyloft Diagnostics report\nPlyloft 1\.176\.1 on /);
    expect(text).toContain("\nWhat Plyloft needs\n");
    expect(text).toContain("- Gives each card its own copy of the project: Ready.");
    expect(text).toContain("- Git identity: Ready. Set.");
    expect(text).toContain("\nProgram folders\n- Setting: not set\n- Plyloft looks in: your login shell");
    expect(text).toContain("  ~/.local/bin\n  /usr/bin");
    expect(text).toContain("\nClaude Code\nClaude Code at ~/.local/bin/claude");
    expect(text).toContain("\nCodex\nCodex: not installed");
    // Scrubbed: no user name, no address, no token.
    expect(text).not.toMatch(/matteo|Ana|ana@|ghp_/);
    expect(await screen.findByText("Copied")).toBeTruthy();
  });

  it("carries the settings that can't work, values scrubbed like paths", async () => {
    act(() =>
      useSettings.setState({
        settings: { ...DEFAULT_SETTINGS, shell: { ...DEFAULT_SETTINGS.shell, tileShell: "/Users/matteo/bin/zsh -i" } },
        loaded: true,
      }),
    );
    const view = renderUi(<DiagnosticsPage scope="this-mac" />, {
      fixtures: {
        dependency_doctor: () => report,
        build_cache_status: () => null,
        watchdog_status: () => null,
        shell_env_info: () => ({ path: "/usr/bin" }),
        cli_repair_report: () => "x",
        setting_check: () => ({
          kind: "tileShell", windows: false, level: "blocked", findings: [{ kind: "hasArguments", program: "/Users/matteo/bin/zsh" }],
          resolved: null, saveAs: null, fix: "/Users/matteo/bin/zsh", broken: true,
        }),
      },
    });
    await screen.findByText("Settings that can't work as written");
    await view.user.click(screen.getByRole("button", { name: "Copy report" }));
    const text = await copied();
    expect(text).toContain("\nSettings that can't work as written\n- Tile shell: ~/bin/zsh -i. It has options after the program");
    expect(text).not.toMatch(/matteo/);
  });

  it("with Program folders set it carries the value and its reading", async () => {
    const view = await open({}, "~/.local/bin/claude");
    await view.user.click(screen.getByRole("button", { name: "Copy report" }));
    const text = await copied();
    expect(text).toContain("- Setting: ~/.local/bin/claude");
    expect(text).toContain("- Reading: Can't work as written: it names a file, not a folder.");
    expect(text).toContain("your Program folders setting");
  });

  it("says a part couldn't be read in its place, and still copies", async () => {
    const view = await open({
      shell_env_info: () => {
        throw new Error("no env");
      },
      cli_repair_report: () => {
        throw new Error("no report");
      },
    });
    await view.user.click(screen.getByRole("button", { name: "Copy report" }));
    const text = await copied();
    expect(text).toContain("The list of folders couldn't be read.");
    expect(text).toContain("\nClaude Code\nIts report couldn't be read.");
    expect(text).toContain("\nCodex\nIts report couldn't be read.");
    expect(text).toContain("- Gives each card its own copy of the project: Ready.");
  });
});
