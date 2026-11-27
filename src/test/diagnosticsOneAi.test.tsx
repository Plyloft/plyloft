// OB-2 (onboarding spec §13.1): one AI is enough. The real DiagnosticsPage,
// the real doctor store, the report through the stubbed `dependency_doctor`,
// shaped as `doctor::build_report_with` answers it:
//
//  - Codex only: Claude's row is optional and says Codex is ready; the page
//    says everything Ply needs is here;
//  - neither: both rows say one is enough, and the page says something is
//    missing;
//  - a newer release: the row stays Ready in the count, says the version and
//    offers a quiet Update (D6);
//  - the Git identity row: `Set` goes where Git's name is set;
//  - Git Bash (Windows) reads in words.
import { describe, expect, it } from "vitest";
import { within } from "@testing-library/react";
import { DiagnosticsPage } from "../components/settings/DiagnosticsPage";
import type { DoctorReport, ToolStatus } from "../ipc";
import { useUi } from "../store/uiStore";
import { useSetup } from "../store/setupStore";
import { useRepair } from "../store/repairStore";
import { act, renderUi, screen } from "./render";

function tool(over: Partial<ToolStatus>): ToolStatus {
  return {
    id: "git",
    name: "Git",
    required: true,
    found: true,
    path: "/usr/bin/git",
    version: "2.50.1",
    versionOk: true,
    detail: "Ready.",
    installCmd: "xcode-select --install",
    docsUrl: "https://git-scm.com/downloads",
    reviewer: null,
    ...over,
  };
}

const claudeMissing = (detail: string) =>
  tool({
    id: "claude",
    name: "Claude Code",
    required: false,
    found: false,
    path: null,
    version: null,
    versionOk: false,
    detail,
    installCmd: "curl -fsSL https://claude.ai/install.sh | bash",
  });

const codex = (over: Partial<ToolStatus> = {}) =>
  tool({
    id: "codex",
    name: "Codex CLI",
    required: false,
    path: "/Users/me/.local/bin/codex",
    version: "0.156.1",
    detail: "Runs your Codex agents.",
    installCmd: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
    auth: {
      signedIn: true,
      detail: "Found and signed in.",
      command: "codex login",
      action: "Sign in",
      optionalStep: false,
    },
    ...over,
  });

function report(tools: ToolStatus[], over: Partial<DoctorReport> = {}): DoctorReport {
  return {
    tools,
    teamSkills: null,
    projectSkills: null,
    microphone: null,
    whisperModel: null,
    dictationShell: null,
    sharedDefinition: null,
    probeError: null,
    allRequiredOk: true,
    aiReady: true,
    gitIdentity: null,
    ...over,
  };
}

async function open(r: DoctorReport, firstText: string) {
  const rendered = renderUi(<DiagnosticsPage scope="this-mac" />, {
    fixtures: {
      dependency_doctor: () => r,
      build_cache_status: () => null,
    },
  });
  await screen.findByText(endsWith(firstText));
  return rendered;
}

/** 1.174.0 (DS7): a row's hint is "<program> <version> · <sentence>"; the
 *  sentence is found at its end. */
function endsWith(text: string | RegExp): string | RegExp {
  if (typeof text !== "string") return text;
  return new RegExp(`${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
}

function rowOf(text: string | RegExp): HTMLElement {
  const row = screen.getByText(endsWith(text)).closest(".ux-row") as HTMLElement | null;
  expect(row, `the row saying ${text}`).not.toBeNull();
  return row as HTMLElement;
}

describe("Diagnostics with one AI (OB-2)", () => {
  it("Codex alone is enough: Claude is optional and nothing is missing", async () => {
    await open(
      report([tool({}), claudeMissing("Not installed. Optional — Codex is ready."), codex()]),
      "Not installed. Optional — Codex is ready.",
    );
    const claude = rowOf("Not installed. Optional — Codex is ready.");
    // 1.174.0 (DS7): titled by what it is for, no chips in the title.
    expect(within(claude).getByText("Claude")).toBeTruthy();
    expect(within(claude).queryByText("Optional")).toBeNull();
    expect(within(claude).queryByText("Required")).toBeNull();
    expect(within(rowOf("Found and signed in.")).getByText("Ready")).toBeTruthy();
    expect(screen.getByText("Everything Plyloft cannot work without is here.")).toBeTruthy();
    expect(screen.queryByText(/Claude Code isn't installed/)).toBeNull();
  });

  it("neither AI: each row says one is enough, and the page says something is missing", async () => {
    await open(
      report(
        [
          tool({}),
          claudeMissing("Not installed. One AI is enough: install Claude Code or Codex."),
          tool({
            id: "codex",
            name: "Codex CLI",
            required: false,
            found: false,
            path: null,
            version: null,
            versionOk: false,
            detail: "Not installed. One AI is enough: install Codex or Claude Code.",
            installCmd: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
          }),
        ],
        { allRequiredOk: false, aiReady: false },
      ),
      "Not installed. One AI is enough: install Claude Code or Codex.",
    );
    expect(screen.getByText(endsWith("Not installed. One AI is enough: install Codex or Claude Code."))).toBeTruthy();
    // Review P3-4: the pair is what is missing — the missing-required state,
    // each with a strong Install; 1.174.0 (DS7): the hint says one is
    // enough, and no chip sits in the title.
    expect(screen.queryByText("One needed")).toBeNull();
    for (const text of [
      "Not installed. One AI is enough: install Claude Code or Codex.",
      "Not installed. One AI is enough: install Codex or Claude Code.",
    ]) {
      const install = within(rowOf(text)).getByRole("button", { name: "Install" });
      expect(install.className).toContain("cbtn--strong");
    }
    expect(
      screen.getByText("Something Plyloft cannot work without is missing — the rows below say which."),
    ).toBeTruthy();
  });

  it("a newer release is offered with a quiet Update and the row stays ready", async () => {
    await open(
      report([
        tool({}),
        codex({
          update: {
            latest: "0.157.1",
            detail: "Version 0.157.1 is available.",
            command: "codex update",
          },
        }),
      ]),
      "Found and signed in. Version 0.157.1 is available.",
    );
    const row = rowOf("Found and signed in. Version 0.157.1 is available.");
    const update = within(row).getByRole("button", { name: "Update" });
    expect(update.className).not.toContain("strong");
    // Counted ready: an update never turns a row amber.
    expect(screen.getByText("2 of 2 ready")).toBeTruthy();
  });

  it("1.176.0 R6: Update goes to Setup's guided update, not a blind shell tile", async () => {
    const { user, tauri } = await open(
      report([tool({}), codex({ update: { latest: "0.157.1", detail: "Version 0.157.1 is available.", command: "codex update" } })]),
      "Found and signed in. Version 0.157.1 is available.",
    );
    await user.click(within(rowOf("Found and signed in. Version 0.157.1 is available.")).getByRole("button", { name: "Update" }));
    expect(useSetup.getState().open).toBe(true);
    expect(useSetup.getState().step).toBe("ai");
    expect(useSetup.getState().aiAction).toEqual({ tool: "codex", action: "update" });
    expect(tauri.callsOf("pty_spawn")).toHaveLength(0);
  });

  it("1.176.0 R6: Reinstall of a Claude that doesn't start opens the Repair sheet", async () => {
    const { user } = await open(
      report([
        tool({}),
        tool({
          id: "claude",
          name: "Claude Code",
          required: false,
          path: "/Users/me/.local/bin/claude",
          version: null,
          versionOk: false,
          detail: "Installed but not starting — reinstall it to use Claude tiles.",
          installCmd: "curl -fsSL https://claude.ai/install.sh | bash",
        }),
        codex(),
      ]),
      "Installed but not starting — reinstall it to use Claude tiles.",
    );
    await user.click(within(rowOf("Installed but not starting — reinstall it to use Claude tiles.")).getByRole("button", { name: "Reinstall" }));
    expect(useRepair.getState().open).toBe(true);
    expect(useRepair.getState().tool).toBe("claude");
  });

  it("offline: no update line", async () => {
    await open(report([tool({}), codex({ update: null })]), "Found and signed in.");
    expect(screen.queryByText(/is available/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
  });

  it("the Git identity row: Set opens Setup at its Git step (OB-6)", async () => {
    const { user } = await open(
      report([tool({}), codex()], {
        gitIdentity: { name: null, email: null, set: false, detail: "Git doesn't know your name yet." },
      }),
      "Git doesn't know your name yet.",
    );
    const row = rowOf("Git doesn't know your name yet.");
    expect(within(row).getByText("Git identity")).toBeTruthy();
    act(() => useSetup.setState({ open: false, step: null }));
    await user.click(within(row).getByRole("button", { name: "Set" }));
    expect(useSetup.getState().open).toBe(true);
    expect(useSetup.getState().setupCase).toBe("rerun");
    expect(useSetup.getState().step).toBe("git");
    // Not Profile any more.
    expect(useUi.getState().settingsSection).not.toBe("profile");
    act(() => useSetup.setState({ open: false, step: null }));
  });

  it("a known identity is Ready", async () => {
    await open(
      report([tool({}), codex()], {
        gitIdentity: {
          name: "Matteo",
          email: "m@example.com",
          set: true,
          detail: "Git knows you as Matteo <m@example.com>.",
        },
      }),
      "Git knows you as Matteo <m@example.com>.",
    );
    expect(within(rowOf("Git knows you as Matteo <m@example.com>.")).getByText("Ready")).toBeTruthy();
  });

  it("Git Bash (Windows) reads in words and is required", async () => {
    const detail =
      "Git works, but Git Bash wasn't found. Plyloft needs it to run project checks; Git for Windows includes it.";
    await open(
      report(
        [
          tool({ path: "C:\\Git\\cmd\\git.exe" }),
          tool({ id: "git-bash", name: "Git Bash", found: false, path: null, version: null, versionOk: false, detail }),
          codex(),
        ],
        { allRequiredOk: false },
      ),
      detail,
    );
    const row = rowOf(detail);
    // 1.174.0 (DS7): titled by what it is for, the program in the hint.
    expect(within(row).getByText("Runs your project checks")).toBeTruthy();
    expect(within(row).getByText(/^Git Bash · /)).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Install Git for Windows" })).toBeTruthy();
  });

  // 1.174.0 (DS7, scene 13): what Plyloft proved about a reviewer, in words;
  // the proof itself is behind ⋯ › Copy details.
  it("a proved reviewer: can't change files, checked when, and Copy details", async () => {
    const proof = "Codex sandbox read-only refused the write; sentinel absent and Git tree clean.";
    const { user } = await open(
      report([
        tool({}),
        codex({
          reviewer: {
            provider: "codex",
            installed: true,
            executablePath: "/Users/me/.local/bin/codex",
            version: "0.156.1",
            level: "os-sandboxed",
            outcome: "passed",
            eligible: true,
            stale: false,
            proof,
            probedAt: Date.now() - 2 * 24 * 60 * 60 * 1000,
            probing: false,
          },
        }),
      ]),
      "Found and signed in.",
    );
    expect(screen.getByRole("heading", { name: "Reviewers can't change files" })).toBeTruthy();
    const row = screen.getByText("Codex as a reviewer").closest(".ux-row") as HTMLElement;
    expect(within(row).getByText("checked 2 days ago")).toBeTruthy();
    expect(row.textContent).not.toContain("sentinel");
    await user.click(within(row).getByRole("button", { name: "More about Codex as a reviewer" }));
    await user.click(screen.getByRole("menuitem", { name: "Copy details" }));
    // user-event's clipboard holds what the page wrote.
    expect(await navigator.clipboard.readText()).toBe(`OS sandboxed: ${proof}`);
  });
});
