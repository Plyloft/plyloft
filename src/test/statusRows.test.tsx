// UX-3.8: the update notice, a missing dependency and the drain are quiet
// rows at the sidebar's foot — a dot, a sentence, one action word — instead of
// banners floating over the window.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceSidebar } from "../components/WorkspaceSidebar";
import { UpdatePromptView, setUpdateFlowForTests } from "../components/UpdatePrompt";
import { UpdateFlow, type UpdateHandle } from "../lib/updateFlow";
import { useDoctor } from "../store/doctorStore";
import { useUi } from "../store/uiStore";
import { useSettings } from "../store/settingsStore";
import { useWorkspaces, type Workspace } from "../store/workspaceStore";
import type { DoctorReport, ShellEnvInfo, ToolStatus } from "../ipc";
import { act, nextFrame, renderUi, screen, tauri, waitFor } from "./render";

afterEach(() => setUpdateFlowForTests(null));

// OB-15: these rows are the doctor's on a Mac that was set up — a project with
// its config — so the "Setup isn't finished" row (setupFinishRow.test.tsx)
// stays out of them.
beforeEach(() => {
  tauri().fixture("project_config_list", [["ws-1", {}]]);
  useWorkspaces.setState({ loaded: true,
    workspaces: [{ id: "ws-1", name: "Lyra", cwd: "/tmp/lyra", createdAt: 1, lastOpenedAt: 1, openFiles: [], activeFile: null } as Workspace],
  });
});

function tool(name: string, found: boolean): ToolStatus {
  // OB-2 (§13.1): git is required; each AI is optional — one is enough.
  const ai = name === "claude" || name === "codex";
  return {
    id: name.toLowerCase(),
    name,
    required: !ai,
    found,
    path: found ? `/usr/bin/${name}` : null,
    version: null,
    versionOk: found,
    detail: "",
    installCmd: "",
    docsUrl: "",
  } as unknown as ToolStatus;
}

function report(tools: ToolStatus[]): DoctorReport {
  const aiReady = tools.some((t) => (t.id === "claude" || t.id === "codex") && t.found);
  return {
    tools,
    teamSkills: null,
    projectSkills: null,
    microphone: null,
    whisperModel: null,
    dictationShell: null,
    sharedDefinition: null,
    probeError: null,
    allRequiredOk: tools.every((t) => !t.required || t.found) && aiReady,
    aiReady,
  } as DoctorReport;
}

async function renderFoot(
  opts: {
    draining?: boolean;
    env?: ShellEnvInfo | null;
    missing?: string[];
    /** OB-2: a Codex row, found or not (absent by default). */
    codex?: boolean;
  } = {},
) {
  tauri().allowUnhandled();
  tauri().fixture("drain_status", { draining: opts.draining ?? false, startedAt: null });
  tauri().fixture("ship_pending_count", 0);
  tauri().fixture("ship_pending_cards", null);
  tauri().fixture("ship_unverified_count", 0);
  const missing = opts.missing ?? [];
  act(() =>
    useDoctor.setState({
      report: report([
        tool("git", !missing.includes("git")),
        tool("claude", !missing.includes("claude")),
        ...(opts.codex === undefined ? [] : [tool("codex", opts.codex)]),
      ]),
    }),
  );
  const r = renderUi(<WorkspaceSidebar env={opts.env ?? null} />);
  await nextFrame();
  return r;
}

const rows = () => [...document.querySelectorAll(".shell-status")].map((r) => r.textContent);

describe("the sidebar's status rows", () => {
  it("say nothing when all is well", async () => {
    await renderFoot();
    expect(rows()).toEqual([]);
    expect(document.querySelector(".dep-banner, .update-banner")).toBeNull();
  });

  it("name a missing tool, and Fix opens Settings › Diagnostics", async () => {
    const r = await renderFoot({ missing: ["git"] });
    expect(rows()).toEqual(["git isn't installed · Fix"]);
    await r.user.click(screen.getByRole("button", { name: "Fix" }));
    expect(useUi.getState().settingsOverlayOpen).toBe(true);
    expect(useUi.getState().settingsSection).toBe("diagnostics");
  });

  it("say no AI tool once, never naming Claude", async () => {
    const env = { claudePath: null, codexPath: null } as unknown as ShellEnvInfo;
    await renderFoot({ env, missing: ["claude"], codex: false });
    // OB-2 (§13.1): the doctor's row says it; the env row stays quiet.
    expect(rows()).toEqual(["No AI tool is installed · Fix"]);
  });

  // 1.176.1: with Program folders set, the tool may be installed elsewhere.
  it("say where Plyloft looked when Program folders is set", async () => {
    act(() =>
      useSettings.setState((st) => ({ settings: { ...st.settings, shell: { ...st.settings.shell, pathOverride: "~/.local/bin/claude" } } })),
    );
    const env = { claudePath: null, codexPath: null } as unknown as ShellEnvInfo;
    await renderFoot({ env, missing: ["claude"], codex: false });
    expect(rows()).toEqual(["Program folders find no AI tool · Fix"]);
  });

  it("say nothing about Claude when Codex is ready", async () => {
    const env = { claudePath: null, codexPath: "/x/codex" } as unknown as ShellEnvInfo;
    await renderFoot({ env, missing: ["claude"], codex: true });
    expect(rows()).toEqual([]);
  });

  it("say an AI found but not ready as such", async () => {
    // Codex found but signed out: its row is found, and no AI is ready.
    const env = { claudePath: null, codexPath: "/x/codex" } as unknown as ShellEnvInfo;
    tauri().allowUnhandled();
    tauri().fixture("drain_status", { draining: false, startedAt: null });
    tauri().fixture("ship_pending_count", 0);
    tauri().fixture("ship_pending_cards", null);
    tauri().fixture("ship_unverified_count", 0);
    const r = report([tool("git", true), tool("claude", false), tool("codex", true)]);
    act(() => useDoctor.setState({ report: { ...r, aiReady: false, allRequiredOk: false } }));
    renderUi(<WorkspaceSidebar env={env} />);
    await nextFrame();
    expect(rows()).toEqual(["No AI tool is ready · Fix"]);
  });

  // 1.176.1: one row at a time, by priority (the AI before git), the rest
  // as "and N more" (needsAttentionRow.test.tsx).
  it("say git and no AI as one row and 'and 1 more'", async () => {
    await renderFoot({ missing: ["git", "claude"] });
    expect(rows()).toEqual(["No AI tool is installed · and 1 more · Fix"]);
  });

  it("say no AI from the env line before the doctor answers", async () => {
    tauri().allowUnhandled();
    tauri().fixture("drain_status", { draining: false, startedAt: null });
    tauri().fixture("ship_pending_count", 0);
    tauri().fixture("ship_pending_cards", null);
    tauri().fixture("ship_unverified_count", 0);
    act(() => useDoctor.setState({ report: null }));
    const none = { claudePath: null, codexPath: null } as unknown as ShellEnvInfo;
    const view = renderUi(<WorkspaceSidebar env={none} />);
    await nextFrame();
    expect(rows()).toContain("No AI tool is installed · Fix");
    view.unmount();
    act(() => useDoctor.setState({ report: null }));
    const codexOnly = { claudePath: null, codexPath: "/x/codex" } as unknown as ShellEnvInfo;
    renderUi(<WorkspaceSidebar env={codexOnly} />);
    await nextFrame();
    expect(rows()).not.toContain("No AI tool is installed · Fix");
    expect(rows().some((r) => r?.includes("Claude"))).toBe(false);
  });

  it("show a drain with Cancel", async () => {
    tauri().fixture("drain_cancel", null);
    const r = await renderFoot({ draining: true });
    // GH #324: the outcome, not the mechanism.
    await waitFor(() => expect(rows()).toEqual(["Waiting to ship · Cancel"]));
    await r.user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(tauri().callsOf("drain_cancel")).toHaveLength(1);
    await waitFor(() => expect(rows()).toEqual([]));
  });

  it("carry an update as a row; Install opens the dialog", async () => {
    const handle: UpdateHandle = {
      version: "1.150.0",
      download: async () => {},
      install: async () => {},
      close: async () => {},
    };
    const flow = new UpdateFlow({
      check: async () => handle,
      relaunch: async () => {},
      log: { info: () => {}, error: () => {} },
    });
    setUpdateFlowForTests(flow);
    await flow.runCheck("poll");
    const r = await renderFoot();
    await waitFor(() => expect(rows()).toEqual(["Plyloft 1.150.0 is available · Install"]));
    // UpdatePrompt draws nothing for "available" — the row is the notice.
    const prompt = renderUi(<UpdatePromptView />);
    expect(prompt.container.innerHTML).toBe("");
    await r.user.click(screen.getByRole("button", { name: "Install" }));
    expect(flow.getState().kind).toBe("confirming");
    expect(rows()).toEqual([]);
  });

  // GH #324: "2 shipped unchecked · Review" — the action a verb that opens
  // the Board, and the row one line: the sentence ellipsizes, never the verb.
  it("say unchecked ships with Review, the action word apart from the sentence", async () => {
    tauri().allowUnhandled();
    tauri().fixture("drain_status", { draining: false, startedAt: null });
    tauri().fixture("ship_pending_count", 0);
    tauri().fixture("ship_pending_cards", null);
    tauri().fixture("ship_unverified_count", 2);
    act(() => useDoctor.setState({ report: report([tool("git", true), tool("claude", true)]) }));
    const r = renderUi(<WorkspaceSidebar env={null} />);
    await waitFor(() => expect(rows()).toEqual(["2 shipped unchecked · Review"]));
    const row = document.querySelector(".shell-status")!;
    expect(row.querySelector(".shell-status-text")?.textContent).toBe("2 shipped unchecked");
    expect(row.querySelector(".shell-status-text button")).toBeNull();
    expect(row.getAttribute("title")).toContain("2 shipped unchecked");
    await r.user.click(screen.getByRole("button", { name: "Review" }));
  });
});
