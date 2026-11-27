// OB-15 (onboarding §9.1): "Setup isn't finished · Finish" at the sidebar's
// foot — shown while a required item (Git, a name and email, an AI tool, a
// project) is seen missing and Setup is closed; Finish opens Setup on the
// first step with something missing; the doctor's rows for the same facts
// fold into it; the header's sidebar dot counts it; and it goes by itself
// when the fact is fixed, with no relaunch.
import { describe, expect, it } from "vitest";
import { WorkspaceSidebar } from "../components/WorkspaceSidebar";
import { useStatusNeedsLook } from "../components/SidebarStatus";
import { useDoctor } from "../store/doctorStore";
import { useSettings, DEFAULT_SETTINGS } from "../store/settingsStore";
import { useSetup } from "../store/setupStore";
import { useWorkspaces, type Workspace } from "../store/workspaceStore";
import type { DoctorReport, ToolStatus } from "../ipc";
import { act, nextFrame, renderUi, screen, tauri, waitFor } from "./render";
import { sayProjectListNotice } from "../lib/unreadableNotices";
import { useProjectListTrouble } from "../store/projectListTrouble";
import { useToasts } from "../store/toastStore";
import { renderHook } from "@testing-library/react";

function tool(id: string, found: boolean): ToolStatus {
  const ai = id === "claude" || id === "codex";
  return {
    id,
    name: id,
    required: !ai,
    found,
    path: found ? `/usr/bin/${id}` : null,
    version: null,
    versionOk: found,
    detail: "",
    installCmd: "",
    docsUrl: "",
  } as unknown as ToolStatus;
}

function report({ git = true, ai = true, identity = true }: { git?: boolean; ai?: boolean; identity?: boolean } = {}) {
  return {
    tools: [tool("git", git), tool("claude", ai)],
    teamSkills: null,
    projectSkills: null,
    microphone: null,
    whisperModel: null,
    dictationShell: null,
    sharedDefinition: null,
    probeError: null,
    allRequiredOk: git && ai,
    aiReady: ai,
    gitWorks: git,
    gitIdentity: identity ? { name: "Ann", email: "ann@example.com" } : { name: null, email: null },
  } as unknown as DoctorReport;
}

const lyra: Workspace = {
  id: "ws-1",
  name: "Lyra",
  cwd: "/tmp/lyra",
  createdAt: 1,
  lastOpenedAt: 1,
  openFiles: [],
  activeFile: null,
};

/** The foot's fixtures, a report, the workspaces, which of them have a
 *  config, and what Setup recorded as skipped. */
async function renderFoot({
  doctor = report(),
  workspaces = [lyra],
  configured = ["ws-1"] as string[] | (() => string[]),
  skipped = {} as Record<string, string>,
} = {}) {
  tauri().allowUnhandled();
  tauri().fixture("drain_status", { draining: false, startedAt: null });
  tauri().fixture("ship_pending_count", 0);
  tauri().fixture("ship_pending_cards", null);
  tauri().fixture("ship_unverified_count", 0);
  tauri().fixture("project_config_list", () =>
    (typeof configured === "function" ? configured() : configured).map((id) => [id, {}]),
  );
  act(() => {
    useSettings.setState({
      settings: { ...DEFAULT_SETTINGS, onboarding: { ...DEFAULT_SETTINGS.onboarding, skipped } },
      loaded: true,
    } as never);
    useWorkspaces.setState({ loaded: true, workspaces, activeId: workspaces[0]?.id ?? null });
    useDoctor.setState({ report: doctor });
  });
  const r = renderUi(<WorkspaceSidebar env={null} />);
  await nextFrame();
  return r;
}

const rows = () => [...document.querySelectorAll(".shell-status")].map((r) => r.textContent);
const FINISH = "Setup isn't finished · Finish";

describe("the Finish setup row", () => {
  it("appears with a skipped required step, folding the doctor's row into it", async () => {
    await renderFoot({ doctor: report({ ai: false }), skipped: { ai: "2026-09-28T10:00:00Z" } });
    await waitFor(() => expect(rows()).toEqual([FINISH]));
    // One row, not two, for the same fact: no "No AI tool is installed".
    expect(rows().some((r) => r?.includes("AI tool"))).toBe(false);
    const row = document.querySelector(".shell-status")!;
    expect(row.getAttribute("title")).toBe("Setup isn't finished. Still to do: install an AI tool.");
  });

  it("disappears when the fact is fixed, without a relaunch", async () => {
    await renderFoot({ doctor: report({ ai: false }), skipped: { ai: "t" } });
    await waitFor(() => expect(rows()).toEqual([FINISH]));
    // The doctor reads again (an install, Diagnostics' Look again).
    act(() => useDoctor.setState({ report: report() }));
    await waitFor(() => expect(rows()).toEqual([]));
  });

  it("shows with no project and goes once a workspace with a config lands", async () => {
    let configured: string[] = [];
    await renderFoot({ workspaces: [], configured: () => configured });
    await waitFor(() => expect(rows()).toEqual([FINISH]));
    expect(document.querySelector(".shell-status")!.getAttribute("title")).toContain(
      "Still to do: add a first project.",
    );
    // A workspace is added and set up: the list is read again on the change.
    configured = ["ws-1"];
    act(() => useWorkspaces.setState({ loaded: true, workspaces: [lyra], activeId: "ws-1" }));
    await waitFor(() => expect(rows()).toEqual([]));
  });

  // 1.175.0 Y3 (owner, 2026-11-09; found by the walks): a project list set
  // aside as unreadable, or refused because a newer Plyloft saved it, leaves
  // the window with no projects. That is not "no project was ever added": a
  // finished Setup looked unfinished and Finish opened it at "add a first
  // project", which a refused list then refuses. While the list is in
  // trouble this launch the row isn't drawn; the list's own notice speaks.
  it.each([
    ["set aside", { kind: "setAside", path: "/c/workspaces.json.broken-17" }],
    ["refused", { kind: "refused", path: "/c/workspaces.json", why: "A newer Plyloft saved this list." }],
  ])("isn't drawn while the project list is in trouble this launch (%s)", async (_kind, notice) => {
    tauri().fixture("project_list_trouble", notice.kind);
    tauri().fixture("project_list_notice", notice);
    tauri().fixture("project_list_notice_reveal", null);
    await sayProjectListNotice();
    expect(useProjectListTrouble.getState().trouble).toBe(notice.kind);
    await renderFoot({ workspaces: [], configured: [] });
    await nextFrame();
    await nextFrame();
    expect(rows()).toEqual([]);
    // The header's sidebar dot doesn't count it either.
    expect(renderHook(() => useStatusNeedsLook()).result.current).toBe(false);
    // The notice is what speaks, and dismissing it changes nothing: the
    // fact is kept for the session.
    expect(useToasts.getState().toasts.map((t) => t.title)).toEqual(["Your project list couldn't be read"]);
    act(() => useToasts.setState({ toasts: [] }));
    await nextFrame();
    expect(rows()).toEqual([]);
  });

  // Round 3: a window that loads again in the same run (the web view's own
  // Reload) is given no notice — the backend hands it out once — and still
  // knows: the fact is read without being taken.
  it.each(["setAside", "refused"])("stays hidden in a window that loaded again, with no notice left to give (%s)", async (kind) => {
    tauri().fixture("project_list_trouble", kind);
    tauri().fixture("project_list_notice", null);
    await sayProjectListNotice();
    expect(useProjectListTrouble.getState().trouble).toBe(kind);
    expect(tauri().callsOf("project_list_trouble")).toHaveLength(1);
    await renderFoot({ workspaces: [], configured: [] });
    await nextFrame();
    await nextFrame();
    expect(rows()).toEqual([]);
    // The notice was said by the first window; this one says nothing twice.
    expect(useToasts.getState().toasts).toEqual([]);
  });

  it("comes back by itself once a project is added to a list that was set aside", async () => {
    tauri().fixture("project_list_trouble", "setAside");
    tauri().fixture("project_list_notice", { kind: "setAside", path: "/c/workspaces.json.broken-17" });
    await sayProjectListNotice();
    await renderFoot({ workspaces: [], configured: [] });
    await nextFrame();
    expect(rows()).toEqual([]);
    // A project is added and not set up yet: the count is the count again.
    act(() => useWorkspaces.setState({ loaded: true, workspaces: [lyra], activeId: "ws-1" }));
    await waitFor(() => expect(rows()).toEqual([FINISH]));
    expect(document.querySelector(".shell-status")!.getAttribute("title")).toContain("Still to do:");
  });

  it("waits for the launch's answer about the list, then shows on a real first run", async () => {
    // The launch asks in the same turn as the first read of the list…
    let answer: (value: null) => void = () => {};
    tauri().fixture("project_list_trouble", () => new Promise<null>((resolve) => (answer = resolve)));
    const asked = sayProjectListNotice();
    expect(useProjectListTrouble.getState().trouble).toBe("pending");
    await renderFoot({ workspaces: [], configured: [] });
    await nextFrame();
    expect(rows()).toEqual([]);
    // …and a list that was simply read, with no project in it, is a first run.
    answer(null);
    await asked;
    expect(useProjectListTrouble.getState().trouble).toBeNull();
    await waitFor(() => expect(rows()).toEqual([FINISH]));
    expect(document.querySelector(".shell-status")!.getAttribute("title")).toContain("Still to do: add a first project.");
  });

  it("goes when Setup closes having fixed it (the doctor and the configs are read again)", async () => {
    let configured: string[] = [];
    tauri().fixture("dependency_doctor", () => report());
    await renderFoot({ configured: () => configured });
    await waitFor(() => expect(rows()).toEqual([FINISH]));
    act(() => useSetup.getState().openSetup("rerun"));
    // While Setup is open the row waits (Setup is where it is being fixed).
    await waitFor(() => expect(rows()).toEqual([]));
    configured = ["ws-1"];
    act(() => useSetup.getState().closeSetup());
    await nextFrame();
    await waitFor(() => expect(rows()).toEqual([]));
    expect(tauri().callsOf("project_config_list").length).toBeGreaterThanOrEqual(2);
  });

  it("Finish opens Setup on the first step with something missing", async () => {
    const r = await renderFoot({ configured: [] });
    await waitFor(() => expect(rows()).toEqual([FINISH]));
    await r.user.click(screen.getByRole("button", { name: "Finish" }));
    // A workspace without a config: Project settings, not First project.
    expect(useSetup.getState()).toMatchObject({ open: true, setupCase: "rerun", step: "config" });
  });

  it("Finish lands on Git for a missing name and email", async () => {
    const r = await renderFoot({ doctor: report({ identity: false }) });
    await waitFor(() => expect(rows()).toEqual([FINISH]));
    await r.user.click(screen.getByRole("button", { name: "Finish" }));
    expect(useSetup.getState().step).toBe("git");
  });

  it("with Git and no project, one row: Finish, on the Git step", async () => {
    const r = await renderFoot({ doctor: report({ git: false }), workspaces: [], configured: [] });
    await waitFor(() => expect(rows()).toEqual([FINISH]));
    expect(rows()).not.toContain("git isn't installed · Fix");
    await r.user.click(screen.getByRole("button", { name: "Finish" }));
    expect(useSetup.getState().step).toBe("git");
  });

  it("after Setup was finished, a tool lost later is the doctor's row", async () => {
    await renderFoot({ doctor: report({ git: false }) });
    await waitFor(() => expect(rows()).toEqual(["git isn't installed · Fix"]));
  });

  it("says nothing before the config list answers", async () => {
    tauri().fixture("project_config_list", () => new Promise(() => {}));
    tauri().allowUnhandled();
    tauri().fixture("drain_status", { draining: false, startedAt: null });
    tauri().fixture("ship_pending_count", 0);
    tauri().fixture("ship_pending_cards", null);
    tauri().fixture("ship_unverified_count", 0);
    act(() => {
      useWorkspaces.setState({ loaded: true, workspaces: [lyra], activeId: "ws-1" });
      useDoctor.setState({ report: report() });
    });
    renderUi(<WorkspaceSidebar env={null} />);
    await nextFrame();
    expect(rows()).toEqual([]);
  });

  it("says nothing, and no dot, while the workspace list is still being read", async () => {
    function Dot() {
      return <span data-testid="dot">{String(useStatusNeedsLook())}</span>;
    }
    tauri().allowUnhandled();
    tauri().fixture("drain_status", { draining: false, startedAt: null });
    tauri().fixture("ship_pending_count", 0);
    tauri().fixture("ship_pending_cards", null);
    tauri().fixture("ship_unverified_count", 0);
    tauri().fixture("project_config_list", []);
    tauri().fixture("workspace_list", () => new Promise(() => {}));
    act(() => useDoctor.setState({ report: report() }));
    void useWorkspaces.getState().refresh();
    renderUi(<WorkspaceSidebar env={null} />);
    renderUi(<Dot />);
    await nextFrame();
    await nextFrame();
    expect(useWorkspaces.getState().loaded).toBe(false);
    expect(rows()).toEqual([]);
    expect(screen.getByTestId("dot").textContent).toBe("false");
  });

  it("says nothing when the workspace list couldn't be read", async () => {
    tauri().allowUnhandled();
    tauri().fixture("drain_status", { draining: false, startedAt: null });
    tauri().fixture("ship_pending_count", 0);
    tauri().fixture("ship_pending_cards", null);
    tauri().fixture("ship_unverified_count", 0);
    tauri().fixture("project_config_list", []);
    tauri().fixture("workspace_list", () => {
      throw new Error("workspaces.json unreadable");
    });
    act(() => useDoctor.setState({ report: report({ identity: false }) }));
    await useWorkspaces.getState().refresh().catch(() => {});
    renderUi(<WorkspaceSidebar env={null} />);
    await nextFrame();
    await nextFrame();
    expect(useWorkspaces.getState().loaded).toBe(false);
    expect(rows()).toEqual([]);
  });

  it("puts the dot on the sidebar button while it shows", async () => {
    function Dot() {
      return <span data-testid="dot">{String(useStatusNeedsLook())}</span>;
    }
    await renderFoot({ configured: [] });
    renderUi(<Dot />);
    await waitFor(() => expect(screen.getByTestId("dot").textContent).toBe("true"));
    act(() => useSetup.getState().openSetup("rerun"));
    await waitFor(() => expect(screen.getByTestId("dot").textContent).toBe("false"));
  });
});
