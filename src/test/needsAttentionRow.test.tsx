// 1.176.1: the sidebar's one "something needs you" row — each class of
// problem the doctor report knows, the single-row rule with "and N more",
// nothing during launch, and the row going by itself when the report changes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceSidebar } from "../components/WorkspaceSidebar";
import { resetGhSignInForTests } from "../components/SidebarStatus";
import { useDoctor } from "../store/doctorStore";
import { useSettings } from "../store/settingsStore";
import { useTiles } from "../store/tileStore";
import { useUi } from "../store/uiStore";
import { useWorkspaces, type Workspace } from "../store/workspaceStore";
import type { DoctorReport, ToolStatus } from "../ipc";
import { act, nextFrame, renderUi, screen, tauri, waitFor } from "./render";
import { resetSettingProblemsForTests } from "../store/settingProblemsStore";
import type { Reading } from "../lib/settingCheck";

const openRepair = vi.fn(async (_tool: string) => {});
vi.mock("../lib/openRepair", () => ({ openRepair: (tool: string) => openRepair(tool) }));

function ws(patch: Partial<Workspace> = {}): Workspace {
  return { id: "ws-1", name: "Lyra", cwd: "/tmp/lyra", createdAt: 1, lastOpenedAt: 1, openFiles: [], activeFile: null, ...patch } as Workspace;
}
function setWorkspace(patch: Partial<Workspace> = {}) {
  act(() => useWorkspaces.setState({ loaded: true, workspaces: [ws(patch)], activeId: "ws-1" }));
}
beforeEach(() => {
  tauri().fixture("project_config_list", [["ws-1", {}]]);
  setWorkspace();
});
afterEach(() => {
  openRepair.mockClear();
  act(() => useTiles.setState({ byWorkspace: {} }));
});

const signedOut = { signedIn: false, detail: "", command: "x auth login", action: "Sign in" };
function tool(id: string, patch: Partial<ToolStatus> = {}): ToolStatus {
  return {
    id, name: id === "git" ? "Git" : id, required: id === "git", found: true, path: `/bin/${id}`, version: "1.0.0",
    versionOk: true, detail: "", installCmd: "", docsUrl: "", reviewer: null, ...patch,
  } as ToolStatus;
}
function report(tools: ToolStatus[], probeError: string | null = null): DoctorReport {
  const aiReady = tools.some((t) => (t.id === "claude" || t.id === "codex") && t.found && t.versionOk && t.auth?.signedIn !== false);
  return {
    tools, teamSkills: null, projectSkills: null, microphone: null, whisperModel: null, dictationShell: null,
    sharedDefinition: null, probeError, aiReady, allRequiredOk: tools.every((t) => !t.required || t.found) && aiReady,
  } as DoctorReport;
}
const healthy = () => [tool("git"), tool("claude"), tool("codex"), tool("gh")];

function setting(patch: { vendor?: "claude" | "codex"; folders?: string }) {
  act(() =>
    useSettings.setState((st) => ({
      settings: {
        ...st.settings,
        behavior: { ...st.settings.behavior, builderVendor: patch.vendor ?? st.settings.behavior.builderVendor },
        shell: { ...st.settings.shell, pathOverride: patch.folders ?? st.settings.shell.pathOverride },
      },
    })),
  );
}

async function renderFoot(r: DoctorReport | null) {
  tauri().allowUnhandled();
  tauri().fixture("drain_status", { draining: false, startedAt: null });
  tauri().fixture("ship_pending_count", 0);
  tauri().fixture("ship_pending_cards", null);
  tauri().fixture("ship_unverified_count", 0);
  act(() => useDoctor.setState({ report: r, codexUpdating: false }));
  const view = renderUi(<WorkspaceSidebar env={null} />);
  await nextFrame();
  return view;
}
const rows = () => [...document.querySelectorAll(".shell-status")].map((r) => r.textContent);

describe("the sidebar's one needs-you row", () => {
  beforeEach(() => setting({ vendor: "claude", folders: "" }));

  it("says nothing when the report is clean, and nothing before the first report", async () => {
    tauri().fixture("dependency_doctor", new Promise(() => {}));
    await renderFoot(null);
    expect(rows()).toEqual([]);
    act(() => useDoctor.setState({ report: report(healthy()) }));
    await nextFrame();
    expect(rows()).toEqual([]);
  });

  it("names GitHub's command only in a project that uses GitHub", async () => {
    const r = report([tool("git"), tool("claude"), tool("gh", { found: false })]);
    await renderFoot(r);
    expect(rows()).toEqual([]);
    setWorkspace({ kanbanSyncMode: "githubIssues", githubOwnerRepo: "me/lyra" });
    await nextFrame();
    expect(rows()).toEqual(["The gh command isn't installed · Fix"]);
    setWorkspace({ shipVia: "github" });
    await nextFrame();
    expect(rows()).toEqual(["The gh command isn't installed · Fix"]);
  });

  it("says GitHub isn't signed in, with Sign in leading to Diagnostics", async () => {
    setWorkspace({ shipVia: "github" });
    const view = await renderFoot(report([tool("git"), tool("claude"), tool("gh", { auth: signedOut })]));
    expect(rows()).toEqual(["GitHub isn't signed in · Sign in"]);
    await view.user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(useUi.getState().settingsSection).toBe("diagnostics");
  });

  it("says a used AI is signed out, not an unused one, nor a state it couldn't read", async () => {
    await renderFoot(report([tool("git"), tool("claude", { auth: signedOut }), tool("codex")]));
    expect(rows()).toEqual(["Claude Code is signed out · Sign in"]);
    act(() => useDoctor.setState({ report: report([tool("git"), tool("claude", { auth: { ...signedOut, signedIn: null } }), tool("codex")]) }));
    await nextFrame();
    expect(rows()).toEqual([]);
    setting({ vendor: "codex" });
    act(() => useDoctor.setState({ report: report([tool("git"), tool("claude", { auth: signedOut }), tool("codex")]) }));
    await nextFrame();
    expect(rows()).toEqual([]);
  });

  it("says the shell couldn't be read", async () => {
    await renderFoot(report(healthy(), "bad answer"));
    expect(rows()).toEqual(["Couldn't read this Mac's program folders · Fix"]);
  });

  it("says no AI tool in Program folders first, with its Fix to Diagnostics", async () => {
    setting({ folders: "~/.local/bin/claude" });
    const view = await renderFoot(report([tool("git"), tool("claude", { found: false, versionOk: false }), tool("codex", { found: false, versionOk: false })]));
    expect(rows()).toEqual(["Program folders find no AI tool · Fix"]);
    await view.user.click(screen.getByRole("button", { name: "Fix" }));
    // Straight to the field, not the page.
    expect(useUi.getState().settingsSection).toBe("editor-terminals");
    expect(useUi.getState().settingsRow).toBe("Program folders");
  });

  it("walk 3: emptying Program folders keeps the row as it was until the new report arrives", async () => {
    setting({ folders: "~/.local/bin/claude" });
    const stale = report([tool("git"), tool("claude", { found: false, versionOk: false }), tool("codex", { found: false, versionOk: false })]);
    await renderFoot(stale);
    expect(rows()).toEqual(["Program folders find no AI tool · Fix"]);
    // The setting lands first; the old report would now read "No AI tool is installed".
    setting({ folders: "" });
    await nextFrame();
    expect(rows()).toEqual(["Program folders find no AI tool · Fix"]);
    act(() => useDoctor.setState({ report: report(healthy()) }));
    await nextFrame();
    expect(rows()).toEqual([]);
  });

  it("with no AI found the backend's probe error adds no second row", async () => {
    const none = [tool("git"), tool("claude", { found: false, versionOk: false }), tool("codex", { found: false, versionOk: false })];
    await renderFoot(report(none, "No AI tool found. Install Claude Code or Codex, or set a PATH override in Settings."));
    expect(rows()).toEqual(["No AI tool is installed · Fix"]);
  });

  it("keeps GitHub's signed-out answer across plain reads, until a fresh one or another account", async () => {
    resetGhSignInForTests();
    setWorkspace({ shipVia: "github" });
    await renderFoot(report([tool("git"), tool("claude"), tool("gh", { auth: signedOut })]));
    expect(rows()).toEqual(["GitHub isn't signed in · Sign in"]);
    // A plain read: no answer on gh.
    act(() => useDoctor.setState({ report: report([tool("git"), tool("claude"), tool("gh")]) }));
    await nextFrame();
    expect(rows()).toEqual(["GitHub isn't signed in · Sign in"]);
    // Another account has no known answer.
    setWorkspace({ shipVia: "github", githubAccount: "other" });
    await nextFrame();
    expect(rows()).toEqual([]);
    setWorkspace({ shipVia: "github" });
    await nextFrame();
    expect(rows()).toEqual(["GitHub isn't signed in · Sign in"]);
    // A fresh read that says signed in clears it.
    act(() => useDoctor.setState({ report: report([tool("git"), tool("claude"), tool("gh", { auth: { ...signedOut, signedIn: true } })]) }));
    await nextFrame();
    expect(rows()).toEqual([]);
  });

  it("shows one row, in priority order, and 'and N more' opens Diagnostics", async () => {
    setWorkspace({ shipVia: "github" });
    const view = await renderFoot(
      report([tool("git", { found: false }), tool("claude", { version: null, versionOk: false }), tool("codex"), tool("gh", { found: false })], "bad answer"),
    );
    // The broken Claude (2) outranks git (3), gh (4) and the shell (6).
    expect(rows()).toEqual(["Claude Code doesn't start · and 3 more · Repair"]);
    await view.user.click(screen.getByRole("button", { name: "Repair" }));
    expect(openRepair).toHaveBeenCalledWith("claude");
    await view.user.click(screen.getByRole("button", { name: "and 3 more" }));
    expect(useUi.getState().settingsSection).toBe("diagnostics");
  });

  it("moves to the next problem, then goes, as the report changes", async () => {
    await renderFoot(report([tool("git", { found: false }), tool("claude", { auth: signedOut }), tool("codex")]));
    expect(rows()).toEqual(["Git isn't installed · and 1 more · Fix"]);
    act(() => useDoctor.setState({ report: report([tool("git"), tool("claude", { auth: signedOut }), tool("codex")]) }));
    await nextFrame();
    expect(rows()).toEqual(["Claude Code is signed out · Sign in"]);
    act(() => useDoctor.setState({ report: report(healthy()) }));
    await nextFrame();
    expect(rows()).toEqual([]);
  });
});

// 1.176.1 (settings checks, wired at merge): a saved setting that certainly
// can't work, from `settingProblemsStore`, after a missing tool and before
// GitHub's items, with "Open the setting".
describe("a saved setting that can't work, in the sidebar row", () => {
  const broken: Reading = {
    kind: "tileShell",
    windows: false,
    level: "blocked",
    findings: [{ kind: "hasArguments", program: "zsh" }],
    resolved: null,
    saveAs: null,
    fix: "zsh",
    broken: true,
  };
  const fine: Reading = { ...broken, level: "ok", findings: [], resolved: "/bin/zsh", saveAs: "/bin/zsh", fix: null, broken: false };
  function tileShell(value: string | null) {
    act(() => useSettings.setState((st) => ({ settings: { ...st.settings, shell: { ...st.settings.shell, tileShell: value } } })));
  }
  beforeEach(() => {
    setting({ vendor: "claude", folders: "" });
    resetSettingProblemsForTests();
  });
  afterEach(() => {
    resetSettingProblemsForTests();
    tileShell(null);
  });

  it("says Tile shell can't start, opens the setting, and goes when it is fixed", async () => {
    tileShell("zsh -i");
    const view = await renderFoot(report(healthy()));
    tauri().fixture("setting_check", ({ value }: Record<string, unknown>) => (value === "zsh -i" ? broken : fine));
    act(() => useDoctor.setState({ report: report(healthy()) }));
    await waitFor(() => expect(rows()).toEqual(["Tile shell can't start · Open the setting"]));
    await view.user.click(screen.getByRole("button", { name: "Open the setting" }));
    expect(useUi.getState().settingsSection).toBe("editor-terminals");
    tileShell("/bin/zsh");
    await waitFor(() => expect(rows()).toEqual([]));
  });

  it("counts in 'and N more', after a missing tool", async () => {
    tileShell("zsh -i");
    tauri().fixture("setting_check", () => broken);
    await renderFoot(report([tool("git", { found: false }), tool("claude"), tool("codex")]));
    act(() => useDoctor.setState({ report: report([tool("git", { found: false }), tool("claude"), tool("codex")]) }));
    await waitFor(() => expect(rows()).toEqual(["Git isn't installed · and 1 more · Fix"]));
  });
});
