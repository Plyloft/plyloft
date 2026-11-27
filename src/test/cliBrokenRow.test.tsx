// 1.176.0 R7: "Codex doesn't start · Repair" at the sidebar's foot — for a
// tool the person uses, installed but broken; never before the doctor's
// first answer; gone by itself once the doctor reads it starting. And the
// one central reading of the backend's "installed but doesn't start": a
// toast gets Repair, an error block a Repair way out.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceSidebar } from "../components/WorkspaceSidebar";
import { ErrorBlock } from "../components/ux/ErrorBlock";
import { useDoctor } from "../store/doctorStore";
import { useSettings } from "../store/settingsStore";
import { useTiles } from "../store/tileStore";
import { pushToast, resetToastsForTests, useToasts } from "../store/toastStore";
import { useWorkspaces, type Workspace } from "../store/workspaceStore";
import type { DoctorReport, ToolStatus } from "../ipc";
import { act, nextFrame, renderUi, screen, tauri } from "./render";

const openRepair = vi.fn(async (_tool: string) => {});
vi.mock("../lib/openRepair", () => ({ openRepair: (tool: string) => openRepair(tool) }));

beforeEach(() => {
  tauri().fixture("project_config_list", [["ws-1", {}]]);
  useWorkspaces.setState({
    loaded: true,
    workspaces: [{ id: "ws-1", name: "Lyra", cwd: "/tmp/lyra", createdAt: 1, lastOpenedAt: 1, openFiles: [], activeFile: null } as Workspace],
  });
});
afterEach(() => {
  openRepair.mockClear();
  act(() => useTiles.setState({ byWorkspace: {} }));
  resetToastsForTests();
});

function tool(id: string, patch: Partial<ToolStatus> = {}): ToolStatus {
  return {
    id,
    name: id,
    required: id === "git",
    found: true,
    path: `/usr/bin/${id}`,
    version: "1.0.0",
    versionOk: true,
    detail: "",
    installCmd: "",
    docsUrl: "",
    reviewer: null,
    ...patch,
  } as ToolStatus;
}

function report(claude: Partial<ToolStatus>, codex: Partial<ToolStatus>): DoctorReport {
  return {
    tools: [tool("git"), tool("claude", claude), tool("codex", codex)],
    teamSkills: null,
    projectSkills: null,
    microphone: null,
    whisperModel: null,
    dictationShell: null,
    sharedDefinition: null,
    probeError: null,
    allRequiredOk: true,
    aiReady: true,
  } as DoctorReport;
}

function chooseAi(vendor: "claude" | "codex") {
  const s = useSettings.getState().settings;
  act(() => useSettings.setState({ settings: { ...s, behavior: { ...s.behavior, builderVendor: vendor } } }));
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

describe("the sidebar's row for a CLI that doesn't start", () => {
  it("names the person's AI when it is installed and doesn't start, and Repair opens its Repair", async () => {
    chooseAi("codex");
    const view = await renderFoot(report({}, { versionOk: false }));
    expect(rows()).toEqual(["Codex doesn't start · Repair"]);
    await view.user.click(screen.getByRole("button", { name: "Repair" }));
    expect(openRepair).toHaveBeenCalledWith("codex");
  });

  it("goes by itself once the doctor reads it starting again", async () => {
    chooseAi("claude");
    await renderFoot(report({ version: null, versionOk: false }, {}));
    expect(rows()).toEqual(["Claude Code doesn't start · Repair"]);
    // `shell-env://changed` → the doctor reads again (doctorStore).
    act(() => useDoctor.setState({ report: report({}, {}) }));
    await nextFrame();
    expect(rows()).toEqual([]);
  });

  it("says nothing during launch, before the doctor's first answer", async () => {
    chooseAi("codex");
    tauri().fixture("dependency_doctor", new Promise(() => {}));
    await renderFoot(null);
    expect(rows()).not.toContain("Codex doesn't start · Repair");
  });

  it("says nothing for a tool the person doesn't use, until they open a tile of it", async () => {
    chooseAi("claude");
    await renderFoot(report({}, { versionOk: false }));
    expect(rows()).toEqual([]);
    act(() => {
      useTiles.getState().addCodexChatTile("ws-1", "/tmp/lyra");
    });
    await nextFrame();
    expect(rows()).toEqual(["Codex doesn't start · Repair"]);
  });

  it("says nothing about Codex while its automatic update runs", async () => {
    chooseAi("codex");
    await renderFoot(report({}, { versionOk: false }));
    act(() => useDoctor.setState({ codexUpdating: true }));
    await nextFrame();
    expect(rows()).toEqual([]);
  });

  it("a slow --version is not a failure (R3's third answer)", async () => {
    chooseAi("claude");
    await renderFoot(report({ version: null, versionOk: true }, {}));
    expect(rows()).toEqual([]);
  });
});

// The backend's typed refusal (`cli_fresh::not_starting`).
const REFUSAL =
  'PLY_CLI_NOT_STARTING_V1:{"tool":"claude"}\n' +
  "Claude Code is installed at /Users/me/.local/bin/claude but doesn't start — its install is incomplete. Repair it in Settings › Setup and account › Diagnostics › Repair, or reinstall it yourself (curl …) and press Look again there.";

describe("the backend's 'installed but doesn't start', mapped once", () => {
  it("a toast with the refusal behind Details gets its sentence and Repair", () => {
    pushToast({ kind: "error", title: "Build not started", body: "Press Start build to try again.", details: REFUSAL });
    const t = useToasts.getState().toasts.slice(-1)[0];
    expect(t.body).toBe("Claude Code is installed but not starting. Repair puts it right.");
    // The mark never shows; the sentence after it does.
    expect(t.details).toBe(REFUSAL.slice(REFUSAL.indexOf("\n") + 1));
    expect(t.action?.label).toBe("Repair Claude Code");
  });

  it("a toast with its own press, or another error, is left as it is", () => {
    const own = { label: "Choose Codex", onClick: () => {} };
    pushToast({ kind: "error", title: "Codex doesn't start on this Mac.", details: REFUSAL, action: own });
    pushToast({ kind: "error", title: "Build not started", body: "Press Start build to try again.", details: "network down" });
    const all = [...useToasts.getState().toasts, ...useToasts.getState().queue];
    const a = all.find((t) => t.title === "Codex doesn't start on this Mac.")!;
    const b = all.find((t) => t.title === "Build not started")!;
    expect(a.action?.label).toBe("Choose Codex");
    expect(b.body).toBe("Press Start build to try again.");
    expect(b.action).toBeUndefined();
  });

  it("an error block shows Repair as its first way out, even with no onAction", async () => {
    const view = renderUi(
      <ErrorBlock
        error={{
          title: "Your message wasn't sent.",
          happened: REFUSAL,
          untouched: "Nothing was changed.",
          todo: "Try again.",
          actions: [],
          details: null,
        }}
      />,
    );
    // The backend's own sentence, without its mark.
    expect(screen.getByText(REFUSAL.slice(REFUSAL.indexOf("\n") + 1))).toBeTruthy();
    expect(document.body.textContent).not.toContain("PLY_CLI_NOT_STARTING_V1");
    await view.user.click(screen.getByRole("button", { name: "Repair Claude Code" }));
    expect(openRepair).toHaveBeenCalledWith("claude");
  });

  it("an error block keeps its own primary as the second way out, and still answers it", async () => {
    const pressed: string[] = [];
    const view = renderUi(
      <ErrorBlock
        error={{
          title: "Build not started.",
          happened: "The program didn't start.",
          untouched: "Nothing was changed.",
          todo: "Try again.",
          actions: [{ id: "choose-codex", label: "Choose Codex", primary: true }],
          details: REFUSAL,
        }}
        onAction={(id) => pressed.push(id)}
      />,
    );
    expect(screen.getByText("Claude Code is installed but not starting. Repair puts it right.")).toBeTruthy();
    await view.user.click(screen.getByRole("button", { name: "Choose Codex" }));
    expect(pressed).toEqual(["choose-codex"]);
    await view.user.click(screen.getByRole("button", { name: "Repair Claude Code" }));
    expect(openRepair).toHaveBeenCalledWith("claude");
    expect(pressed).toEqual(["choose-codex"]);
  });
});
